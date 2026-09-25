#!/usr/bin/env node

import readline from "node:readline";
import { appendFileSync } from "node:fs";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const tty = process.stdout.isTTY || Boolean(process.env.GITHUB_ACTIONS);

const C = {
  reset: tty ? "\x1b[0m" : "",
  bold: tty ? "\x1b[1m" : "",
  dim: tty ? "\x1b[2m" : "",
  cyan: tty ? "\x1b[36m" : "",
  blue: tty ? "\x1b[34m" : "",
  magenta: tty ? "\x1b[35m" : "",
  green: tty ? "\x1b[32m" : "",
  yellow: tty ? "\x1b[33m" : "",
  red: tty ? "\x1b[31m" : "",
  gray: tty ? "\x1b[90m" : "",
};

let lastUsage = null;
let streamedText = "";
let outputNeedsNewline = false;
let streamAtLineStart = true;
let streamKind = null;
let openGroup = false;
let pendingStream = "";
const sessionStarted = Date.now();
let responseStarted = null;
let firstTokenAt = null;
let responseNumber = 0;
let thinkingStreamed = false;
let textStreamed = false;
let reasoningAvailable = false;
const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
let measuredResponses = 0;
let totalResponseMs = 0;
const activeTools = new Map();
let toolCount = 0;
let reportedFinal = false;
const issue = /^\d+$/.test(process.env.PI_ISSUE ?? "") ? Number(process.env.PI_ISSUE) : null;
const phase = process.env.PI_PHASE ?? "agent";
const call = process.env.PI_CALL ?? "main";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

// Job Summary mirror: unlike ::group::, HTML <details> in $GITHUB_STEP_SUMMARY nests,
// so the full run tree (turn > thinking/response/tool > args/result) is browsable there.
const turns = [];
let currentTurn = null;

if (issue != null) console.log(`PI_TASK ${JSON.stringify({ issue, phase, call })}`);

function recordMetric(metric) {
  const line = JSON.stringify(metric);
  console.log(`PI_METRIC ${line}`);
  if (process.env.PI_METRICS_FILE) appendFileSync(process.env.PI_METRICS_FILE, line + "\n");
}

const sensitiveKey = /^(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|credential|cookie|set-cookie|gh_token|github_token)$/i;

function redact(value, key = "") {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|gh_token|github_token|cookie|set-cookie)(["']?)\s*([=:])\s*["']?([^\s&,;"']+)/gi, "$1$2$3[REDACTED]")
      .replace(/\b(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[REDACTED]");
  }
  return value;
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n" + C.dim + "… truncated " + (text.length - limit) + " chars" + C.reset;
}

function stringify(value, limit = 7000) {
  let out;
  try {
    out = typeof value === "string" ? redact(value) : JSON.stringify(redact(value), null, 2);
  } catch {
    out = "[Unserializable value]";
  }
  return truncate(String(out), limit);
}

function extractResultText(result) {
  if (typeof result === "string") return redact(result);
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (text) return redact(text);
  }
  return stringify(result);
}

function finalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  const message = [...messages].reverse().find((candidate) => candidate?.role === "assistant");
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function ensureNewline() {
  flushStream(true);
  if (outputNeedsNewline) {
    process.stdout.write("\n");
    outputNeedsNewline = false;
    streamAtLineStart = true;
  }
}

function closeGroup() {
  if (!openGroup) return;
  ensureNewline();
  if (process.env.GITHUB_ACTIONS) console.log("::endgroup::");
  openGroup = false;
}

function startGroup(title, color = C.blue) {
  closeGroup();
  if (process.env.GITHUB_ACTIONS) {
    console.log("::group::" + oneLine(title, 130));
    openGroup = true;
  } else {
    console.log(color + C.bold + title + C.reset);
  }
}

function emitStream(content) {
  for (const fragment of String(redact(content)).split(/(\r\n|\r|\n)/)) {
    if (fragment === "\n" || fragment === "\r" || fragment === "\r\n") {
      process.stdout.write("\n");
      streamAtLineStart = true;
    } else if (fragment) {
      if (streamAtLineStart) process.stdout.write("  ");
      const color = streamKind === "thinking" ? C.blue : C.green;
      process.stdout.write(color + fragment + C.reset);
      streamAtLineStart = false;
    }
  }
  outputNeedsNewline = !streamAtLineStart;
}

function flushStream(final = false) {
  // Keep incomplete lines together so a token split between Pi deltas is redacted.
  // For long ordinary lines, release a safe prefix to retain live progress.
  while (/[\r\n]/.test(pendingStream)) {
    const end = pendingStream.search(/[\r\n]/) + 1;
    emitStream(pendingStream.slice(0, end));
    pendingStream = pendingStream.slice(end);
  }
  if (final) {
    if (pendingStream) emitStream(pendingStream);
    pendingStream = "";
  } else if (pendingStream.length > 1024 &&
    !/\b(?:Bearer\s+|(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|gh_token|github_token|cookie|set-cookie)["']?\s*[=:]|gh[pousr]_|github_pat_)/i.test(pendingStream)) {
    const safe = pendingStream.length - 512;
    emitStream(pendingStream.slice(0, safe));
    pendingStream = pendingStream.slice(safe);
  }
}

function streamContent(kind, content) {
  if (!content) return;
  if (streamKind !== kind) {
    ensureNewline();
    startGroup(kind === "thinking" ? "💭 Thinking" : "📝 Response", kind === "thinking" ? C.blue : C.green);
    streamKind = kind;
  }
  pendingStream += String(content);
  flushStream();
}

function duration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function usageSummary(usage) {
  if (!usage || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].some((key) => Number.isFinite(usage[key]))) {
    return "tokens unavailable";
  }
  const fields = [["input", "in"], ["output", "out"], ["cacheRead", "cache read"], ["cacheWrite", "cache write"], ["totalTokens", "total"]];
  return fields.filter(([key]) => Number.isFinite(usage[key]))
    .map(([key, label]) => `${label} ${usage[key].toLocaleString("en-US")}`).join(" · ");
}

function heading(icon, text, color = C.cyan) {
  closeGroup();
  ensureNewline();
  console.log(color + C.bold + icon + " " + text + C.reset);
}

function oneLine(value, limit = 110) {
  const line = String(redact(value ?? "")).replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

function detailLines(text, color = C.dim) {
  // Prefix untrusted tool output so it cannot become a GitHub workflow command.
  for (const line of String(text).split(/\r\n|\r|\n/)) console.log("  " + color + line + C.reset);
}

function printToolDetails(title, args, result, isError) {
  // GitHub's raw log only folds one level deep, so a tool call gets a single
  // group (or, with nothing to show, a single plain line) titled with
  // everything useful for scanning without expanding it.
  if (args == null && result == null) {
    heading(isError ? "✗" : "✓", title, isError ? C.red : C.green);
    return;
  }
  startGroup((isError ? "✗ " : "✓ ") + title, isError ? C.red : C.green);
  try {
    if (args != null) {
      console.log(C.dim + "Arguments:" + C.reset);
      detailLines(stringify(args, 16000), C.magenta);
    }
    if (result != null) {
      const output = truncate(String(extractResultText(result)), 32000);
      if (output.trim()) {
        console.log(C.dim + "Result:" + C.reset);
        detailLines(output, isError ? C.red : C.dim);
      }
    }
  } finally {
    closeGroup();
  }
}

function reportFinal(status) {
  if (reportedFinal) return;
  reportedFinal = true;
  closeGroup();
  const elapsed = Date.now() - sessionStarted;
  heading(status === "completed" ? "■" : "◼", `Agent ${status} · ${duration(elapsed)}`, status === "completed" ? C.green : C.yellow);
  console.log(C.gray + `Model totals (${measuredResponses} responses): ${measuredResponses ? usageSummary(totals) : "tokens unavailable"} · response time ${duration(totalResponseMs)} · tools ${toolCount}` + C.reset);
  if (status !== "completed") console.log(C.yellow + "Only completed model responses are counted." + C.reset);
  buildJobSummary(status);
}

function divider() {
  console.log(C.gray + "─".repeat(72) + C.reset);
}

function toolSummary(name, args) {
  if (!args || typeof args !== "object") return "";
  if (name === "bash" && typeof args.command === "string") return "$ " + args.command;
  if (["read", "write", "edit"].includes(name) && typeof args.path === "string") return args.path;
  if (typeof args.query === "string") return args.query;
  if (typeof args.pattern === "string") return args.pattern;
  return "";
}

function appendCapped(base, addition, limit = 20000) {
  if (base.length >= limit) return base;
  return (base + addition).slice(0, limit);
}

function getCurrentTurn() {
  if (!currentTurn) {
    currentTurn = { number: responseNumber || turns.length + 1, metaLine: null, thinking: "", response: "", tools: [] };
    turns.push(currentTurn);
  }
  return currentTurn;
}

function escHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdCodeBlock(text, lang = "") {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence + lang + "\n" + text + "\n" + fence;
}

function buildJobSummary(status) {
  if (!summaryFile) return;
  const elapsed = Date.now() - sessionStarted;
  const lines = [];
  lines.push(`## Pi agent run${issue != null ? ` · issue #${issue}` : ""} · ${phase}/${call}`, "");
  lines.push(`**Status:** ${status} · **Duration:** ${duration(elapsed)} · **Responses:** ${measuredResponses} · **Tools:** ${toolCount}`);
  lines.push(`**Tokens:** ${measuredResponses ? usageSummary(totals) : "tokens unavailable"}`, "");
  for (const turn of turns) {
    lines.push("<details>", `<summary>◉ Model #${turn.number}${turn.metaLine ? " · " + escHtml(turn.metaLine) : ""}</summary>`, "");
    const thinking = redact(turn.thinking).trim();
    if (thinking) {
      lines.push("<details><summary>💭 Thinking</summary>", "", mdCodeBlock(truncate(thinking, 6000)), "", "</details>", "");
    }
    const response = redact(turn.response).trim();
    if (response) {
      lines.push("<details><summary>📝 Response</summary>", "", truncate(response, 6000), "", "</details>", "");
    }
    for (const tool of turn.tools) {
      const icon = tool.isError ? "✗" : tool.ms == null ? "…" : "✓";
      const took = tool.ms == null ? "" : ` · ${duration(tool.ms)}`;
      const hint = tool.hint ? " · " + escHtml(oneLine(tool.hint, 90)) : "";
      lines.push(`<details><summary>${icon} ${escHtml(tool.name)}${hint}${tool.isError ? " · failed" : ""}${took}</summary>`, "");
      if (tool.args != null) lines.push("**Arguments**", "", mdCodeBlock(stringify(tool.args, 8000), "json"), "");
      if (tool.result != null) {
        const output = truncate(String(extractResultText(tool.result)), 8000);
        if (output.trim()) lines.push("**Result**", "", mdCodeBlock(output), "");
      }
      lines.push("</details>", "");
    }
    lines.push("</details>", "");
  }
  appendFileSync(summaryFile, lines.join("\n") + "\n");
}

for await (const line of rl) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { heading("!", "Unparsed Pi event: " + oneLine(line)); continue; }
  if (event.usage) lastUsage = event.usage;

  switch (event.type) {
    case "session":
      divider();
      heading("◆", "Pi session " + (event.id ?? "started"), C.cyan);
      divider();
      break;
    case "agent_start":
      heading("▶", "Agent started", C.green);
      break;
    case "turn_start":
      responseStarted = Date.now();
      firstTokenAt = null;
      thinkingStreamed = false;
      textStreamed = false;
      streamKind = null;
      lastUsage = null;
      responseNumber += 1;
      currentTurn = { number: responseNumber, metaLine: null, thinking: "", response: "", tools: [] };
      turns.push(currentTurn);
      heading("◉", `Model #${responseNumber} · ${new Date().toISOString().slice(11, 19)} UTC`, C.blue);
      break;
    case "message_start":
      if (event.message?.role === "assistant" && responseStarted == null) responseStarted = Date.now();
      break;
    case "message_update": {
      const update = event.assistantMessageEvent ?? {};
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        const delta = typeof update.delta === "string" ? update.delta : "";
        if (delta) {
          firstTokenAt ??= Date.now();
          streamContent(update.type === "thinking_delta" ? "thinking" : "text", delta);
          const turn = getCurrentTurn();
          if (update.type === "thinking_delta") {
            thinkingStreamed = true;
            reasoningAvailable = true;
            turn.thinking = appendCapped(turn.thinking, delta);
          } else {
            textStreamed = true;
            streamedText = (streamedText + delta).slice(-24000);
            turn.response = appendCapped(turn.response, delta);
          }
        }
      }
      break;
    }
    case "message_end": {
      const message = event.message;
      if (message?.role !== "assistant") break;
      const turn = getCurrentTurn();
      if (!thinkingStreamed) {
        const thought = message.content?.filter((part) => part.type === "thinking")
          .map((part) => part.thinking ?? part.text ?? "").join("\n");
        if (thought) {
          streamContent("thinking", thought);
          reasoningAvailable = true;
          turn.thinking = appendCapped(turn.thinking, thought);
        }
      }
      if (!textStreamed) {
        const response = message.content?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "").join("");
        if (response) {
          streamContent("text", response);
          streamedText = (streamedText + response).slice(-24000);
          turn.response = appendCapped(turn.response, response);
        }
      }
      const usage = message.usage ?? lastUsage;
      if (usage && Object.values(usage).some(Number.isFinite)) {
        for (const key of Object.keys(totals)) {
          if (Number.isFinite(usage[key])) totals[key] += usage[key];
        }
        measuredResponses += 1;
      }
      const elapsed = responseStarted == null ? null : Date.now() - responseStarted;
      if (elapsed != null) totalResponseMs += elapsed;
      const timing = elapsed == null ? "time unavailable" : `response ${duration(elapsed)}`;
      const first = firstTokenAt == null || responseStarted == null ? "" : ` · first token ${duration(firstTokenAt - responseStarted)}`;
      const speed = elapsed && Number.isFinite(usage?.output) ? ` · ${(usage.output / (elapsed / 1000)).toFixed(1)} out tok/s` : "";
      const metaLine = `${timing}${first} · ${usageSummary(usage)}${speed}`;
      turn.metaLine = metaLine;
      heading("✓", `Model #${responseNumber} · ${metaLine}`, C.yellow);
      if (issue != null && usage && Object.values(usage).some(Number.isFinite)) {
        const fields = Object.fromEntries(Object.keys(totals).filter((key) => Number.isFinite(usage[key])).map((key) => [key, usage[key]]));
        recordMetric({ issue, phase, call, response: responseNumber, usage: fields, responseMs: elapsed });
      }
      responseStarted = null;
      streamKind = null;
      break;
    }
    case "tool_execution_start": {
      const name = event.toolName ?? "unknown";
      const hint = toolSummary(name, event.args);
      const summaryRecord = { name, hint, args: event.args, isError: false, result: undefined, ms: null };
      getCurrentTurn().tools.push(summaryRecord);
      activeTools.set(event.toolCallId, { name, args: event.args, at: Date.now(), summaryRecord });
      toolCount += 1;
      heading("🔧", name + (hint ? " · " + oneLine(hint) : ""), C.magenta);
      break;
    }
    case "tool_execution_end": {
      const started = activeTools.get(event.toolCallId);
      activeTools.delete(event.toolCallId);
      const name = event.toolName ?? started?.name ?? "unknown";
      const isError = Boolean(event.isError);
      const ms = started?.at == null ? null : Date.now() - started.at;
      const took = ms == null ? "" : ` · ${duration(ms)}`;
      const hint = toolSummary(name, started?.args);
      const title = name + (hint ? " · " + oneLine(hint, 80) : "") + (isError ? " · failed" : "") + took;
      printToolDetails(title, started?.args, event.result, isError);
      if (started?.summaryRecord) {
        started.summaryRecord.isError = isError;
        started.summaryRecord.result = event.result;
        started.summaryRecord.ms = ms;
      }
      break;
    }
    case "turn_end":
      break;
    case "compaction_start": heading("↻", "Context compaction started", C.yellow); break;
    case "compaction_end": heading("✓", "Context compaction finished", C.green); break;
    case "auto_retry_start": heading("↻", "Automatic retry", C.yellow); break;
    case "auto_retry_end": heading("✓", "Retry finished", C.green); break;
    case "extension_error":
      heading("✗", "Extension error", C.red);
      console.log(C.red + stringify(event, 4000) + C.reset);
      break;
    case "agent_end": {
      closeGroup();
      const finalText = finalAssistantText(event.messages);
      if (finalText.trim() && !streamedText.trimEnd().endsWith(finalText.trimEnd())) {
        console.log();
        console.log(C.bold + "Final response" + C.reset);
        detailLines(truncate(redact(finalText), 12000));
      }
      reportFinal("completed");
      if (!reasoningAvailable) console.log(C.gray + "Thinking text: not provided by the model" + C.reset);
      divider();
      break;
    }
  }
}
flushStream(true);
reportFinal("interrupted");

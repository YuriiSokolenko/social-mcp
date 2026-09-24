#!/usr/bin/env node

import readline from "node:readline";

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
let pendingStream = "";
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

function emitStream(content) {
  for (const fragment of String(redact(content)).split(/(\r\n|\r|\n)/)) {
    if (fragment === "\n" || fragment === "\r" || fragment === "\r\n") {
      process.stdout.write("\n");
      streamAtLineStart = true;
    } else if (fragment) {
      if (streamAtLineStart) process.stdout.write("  ");
      process.stdout.write(fragment);
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
    heading(kind === "thinking" ? "💭" : "📝", kind === "thinking" ? "Thinking" : "Response", C.blue);
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
  ensureNewline();
  console.log(color + C.bold + icon + " " + text + C.reset);
}

function oneLine(value, limit = 110) {
  const line = String(redact(value ?? "")).replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

function detailLines(text) {
  // Prefix untrusted tool output so it cannot become a GitHub workflow command.
  for (const line of String(text).split(/\r\n|\r|\n/)) console.log("  " + line);
}

function printToolDetails(name, args, result, isError) {
  if (args == null && result == null) return;
  const grouped = Boolean(process.env.GITHUB_ACTIONS);
  if (grouped) console.log("::group::" + oneLine(name, 60) + " " + (isError ? "error" : "details"));
  try {
    if (args != null) {
      console.log(C.dim + "Arguments:" + C.reset);
      detailLines(stringify(args, 5000));
    }
    if (result != null) {
      const output = truncate(String(extractResultText(result)), 8000);
      if (output.trim()) {
        console.log(C.dim + "Result:" + C.reset);
        detailLines(output);
      }
    }
  } finally {
    if (grouped) console.log("::endgroup::");
  }
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
      heading("◉", `Model request #${responseNumber} started`, C.blue);
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
          if (update.type === "thinking_delta") {
            thinkingStreamed = true;
            reasoningAvailable = true;
          } else {
            textStreamed = true;
            streamedText = (streamedText + delta).slice(-24000);
          }
        }
      }
      break;
    }
    case "message_end": {
      const message = event.message;
      if (message?.role !== "assistant") break;
      if (!thinkingStreamed) {
        const thought = message.content?.filter((part) => part.type === "thinking")
          .map((part) => part.thinking ?? part.text ?? "").join("\n");
        if (thought) {
          streamContent("thinking", thought);
          reasoningAvailable = true;
        }
      }
      if (!textStreamed) {
        const response = message.content?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "").join("");
        if (response) {
          streamContent("text", response);
          streamedText = (streamedText + response).slice(-24000);
        }
      }
      const usage = message.usage ?? lastUsage;
      if (message.usage) {
        for (const key of Object.keys(totals)) {
          if (Number.isFinite(message.usage[key])) totals[key] += message.usage[key];
        }
        measuredResponses += 1;
      }
      const elapsed = responseStarted == null ? null : Date.now() - responseStarted;
      if (elapsed != null) totalResponseMs += elapsed;
      const timing = elapsed == null ? "time unavailable" : `response ${duration(elapsed)}`;
      const first = firstTokenAt == null || responseStarted == null ? "" : ` · first token ${duration(firstTokenAt - responseStarted)}`;
      heading("◷", `Model #${responseNumber}: ${timing}${first} · ${usageSummary(usage)}`, C.yellow);
      responseStarted = null;
      streamKind = null;
      break;
    }
    case "tool_execution_start": {
      const name = event.toolName ?? "unknown";
      const summary = toolSummary(name, event.args);
      activeTools.set(event.toolCallId, { name, args: event.args });
      const hint = summary ? " · " + oneLine(summary) : "";
      heading("🔧", name + hint, C.magenta);
      break;
    }
    case "tool_execution_end": {
      const started = activeTools.get(event.toolCallId);
      activeTools.delete(event.toolCallId);
      const name = event.toolName ?? started?.name ?? "unknown";
      const isError = Boolean(event.isError);
      heading(isError ? "✗" : "✓", name + (isError ? " failed" : " completed"), isError ? C.red : C.green);
      printToolDetails(name, started?.args, event.result, isError);
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
      console.log();
      divider();
      heading("■", "Agent finished", C.green);
      const finalText = finalAssistantText(event.messages);
      if (finalText.trim() && !streamedText.trimEnd().endsWith(finalText.trimEnd())) {
        console.log();
        console.log(C.bold + "Final response" + C.reset);
        detailLines(truncate(redact(finalText), 12000));
      }
      if (measuredResponses) {
        console.log(C.gray + `Model totals (${measuredResponses} responses): ${usageSummary(totals)} · response time ${duration(totalResponseMs)}` + C.reset);
      }
      if (!reasoningAvailable) console.log(C.gray + "Thinking text: not provided by the model" + C.reset);
      divider();
      break;
    }
  }
}
flushStream(true);

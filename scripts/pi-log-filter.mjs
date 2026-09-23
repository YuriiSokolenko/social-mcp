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
const activeTools = new Map();

const sensitiveKey = /^(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|credential|cookie|set-cookie)$/i;

function redact(value, key = "") {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(access_token|refresh_token|client_secret|api_key)=([^&\s]+)/gi, "$1=[REDACTED]");
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
    out = String(value);
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
  if (outputNeedsNewline) {
    process.stdout.write("\n");
    outputNeedsNewline = false;
  }
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
  for (const line of String(text).split("\n")) console.log("  " + line);
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
      // Avoid a header and token counts for every model turn.
      break;
    case "message_update": {
      const update = event.assistantMessageEvent ?? {};
      if (update.type === "text_delta") {
        const delta = update.delta ?? "";
        process.stdout.write(delta);
        streamedText = (streamedText + delta).slice(-24000);
        outputNeedsNewline = !delta.endsWith("\n");
      }
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
        console.log(truncate(redact(finalText), 12000));
      }
      if (lastUsage?.totalTokens != null) console.log(C.gray + "Total tokens: " + lastUsage.totalTokens + C.reset);
      divider();
      break;
    }
  }
}

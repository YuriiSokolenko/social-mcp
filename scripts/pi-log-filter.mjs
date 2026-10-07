#!/usr/bin/env node

import readline from "node:readline";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { appendDiagnostic } from "./pi-common/diagnostics-artifact.mjs";

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
let redactingPrivateKey = false;
let assistantMessageStarted = false;
let runtimeFailureSignatureSeen = null;
let runtimeFailureSettlementClaimed = false;
const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
let cacheReadKnownResponses = 0;
let cacheReadUnknownResponses = 0;
let measuredResponses = 0;
let totalResponseMs = 0;
const activeTools = new Map();
let toolCount = 0;
let reportedFinal = false;
let lastAgentEndSeen = false;
let subagentMetricNumber = 0;
const issue = /^\d+$/.test(process.env.PI_ISSUE ?? "") ? Number(process.env.PI_ISSUE) : null;
const phase = process.env.PI_PHASE ?? "agent";
const call = process.env.PI_CALL ?? "main";
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const activityFile = process.env.PI_ACTIVITY_FILE;
const runtimeFailureFile = process.env.PI_RUNTIME_FAILURE_FILE;
const diagnosticsFile = process.env.PI_DIAGNOSTICS_FILE;
let diagnosticNumber = 0;
const ARGS_DISPLAY_CHARS = 4000;
const RESULT_DISPLAY_CHARS = 8000;
let lastRelevantTool = "none";
let lastRelevantCheck = "none";

function runtimeFailureSignature() {
  if (!runtimeFailureFile || !existsSync(runtimeFailureFile)) return null;
  try {
    const stat = statSync(runtimeFailureFile);
    // recordRuntimeAbort writes a fresh temp file then atomically renames it over the target.
    // Track that file generation, not JSON contents: two distinct aborts may intentionally carry
    // byte-identical failure records and each still owns its own synthetic settlement.
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

function recordActivity(kind, extra = {}) {
  if (!activityFile) return;
  appendFileSync(activityFile, JSON.stringify({ at: Date.now(), kind, ...extra }) + "\n");
}

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

function normalizedUsage(value) {
  if (!value || typeof value !== "object") return null;
  const keys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (!keys.some((key) => Number.isFinite(value[key]))) return null;
  const usage = Object.fromEntries(keys
    .filter((key) => Number.isFinite(value[key]))
    .map((key) => [key, value[key]]));
  if (!Number.isFinite(usage.totalTokens)) {
    usage.totalTokens = (usage.input ?? 0) + (usage.output ?? 0)
      + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  }
  return usage;
}

function providerTelemetryFor(logicalCall, logicalResponse) {
  const file = process.env.PI_METRICS_FILE;
  if (!file || !existsSync(file)) return null;
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]) continue;
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      if (
        record?.record_type === "provider_response" &&
        record?.logical_call === logicalCall &&
        record?.logical_response === logicalResponse
      ) return record;
    }
  } catch { /* provider tracing is best effort */ }
  return null;
}

function usageWithProviderCacheTelemetry(value, providerTelemetry) {
  const usage = normalizedUsage(value);
  if (!usage) return null;
  if (
    providerTelemetry?.cache_telemetry === "reported" &&
    Number.isSafeInteger(providerTelemetry.cached_tokens) &&
    providerTelemetry.cached_tokens >= 0
  ) {
    usage.cacheRead = providerTelemetry.cached_tokens;
    usage.cacheReadKnown = true;
  } else if (providerTelemetry) {
    // A traced provider response is authoritative. If its cache field is absent, Pi/SDK
    // defaults (including a numeric cacheRead) cannot upgrade "unknown" into a cache hit.
    delete usage.cacheRead;
    usage.cacheReadKnown = false;
  } else if (Number.isFinite(usage.cacheRead) && usage.cacheRead > 0) {
    // If transport tracing itself is unavailable, preserve an explicitly positive SDK value.
    // A zero remains ambiguous because compatible clients commonly synthesize it.
    usage.cacheReadKnown = true;
  } else {
    delete usage.cacheRead;
    usage.cacheReadKnown = false;
  }
  return usage;
}

function finalizedToolUsage(result) {
  return normalizedUsage(result?.usage) ?? normalizedUsage(result?.details?.usage);
}

const sensitiveKey = /(^|[_-])(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|credential|cookie|set-cookie|gh[_-]?token|github[_-]?token|token|secret|private[_-]?key)([_-]|$)/i;

function redact(value, key = "") {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  if (typeof value === "string") {
    let sanitized = value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
      .replace(/::add-mask::[^\r\n]*/gi, "::add-mask::[REDACTED]")
      .replace(/\b([A-Za-z_][A-Za-z0-9_-]*)(["']?)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/g, (match, name, quote, separator) =>
        sensitiveKey.test(name) ? `${name}${quote}${separator}[REDACTED]` : match)
      .replace(/\b(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[REDACTED]");
    const knownSecrets = Object.entries(process.env)
      .filter(([name, secret]) => sensitiveKey.test(name) && typeof secret === "string" && secret.length > 0)
      .map(([, secret]) => secret)
      .sort((left, right) => right.length - left.length);
    for (const secret of knownSecrets) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    return sanitized;
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
    console.log("::group::" + oneLine(`[PI][${phase}/${call}] ${title}`, 160));
    openGroup = true;
  } else {
    console.log(color + C.bold + title + C.reset);
  }
}

function emitStream(content) {
  for (const fragment of String(content).split(/(\r\n|\r|\n)/)) {
    if (fragment === "\n" || fragment === "\r" || fragment === "\r\n") {
      process.stdout.write("\n");
      streamAtLineStart = true;
      continue;
    }
    if (!fragment) continue;

    if (redactingPrivateKey) {
      if (/-----END [^-]*PRIVATE KEY-----/.test(fragment)) redactingPrivateKey = false;
      continue;
    }

    let safe = fragment;
    if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(fragment)) {
      redactingPrivateKey = true;
      safe = "[REDACTED PRIVATE KEY]";
    } else {
      safe = String(redact(fragment));
    }
    if (streamAtLineStart) process.stdout.write("  ");
    const color = streamKind === "thinking" ? C.blue : C.green;
    process.stdout.write(color + safe + C.reset);
    streamAtLineStart = false;
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
  const parts = [];
  if (Number.isFinite(usage.input)) parts.push(`in ${usage.input.toLocaleString("en-US")}`);
  if (Number.isFinite(usage.output)) parts.push(`out ${usage.output.toLocaleString("en-US")}`);
  if (Number.isSafeInteger(usage.cacheReadUnknownResponses) && usage.cacheReadUnknownResponses > 0) {
    parts.push(
      Number.isSafeInteger(usage.cacheReadKnownResponses) && usage.cacheReadKnownResponses > 0
        ? `cache read ${(usage.cacheRead ?? 0).toLocaleString("en-US")} + unknown`
        : "cache read unknown"
    );
  } else if (usage.cacheReadKnown === false) {
    parts.push("cache read unknown");
  } else if (Number.isFinite(usage.cacheRead)) {
    parts.push(`cache read ${usage.cacheRead.toLocaleString("en-US")}`);
  }
  if (Number.isFinite(usage.cacheWrite)) parts.push(`cache write ${usage.cacheWrite.toLocaleString("en-US")}`);
  if (Number.isFinite(usage.totalTokens)) parts.push(`total ${usage.totalTokens.toLocaleString("en-US")}`);
  return parts.join(" · ");
}

function heading(icon, text, color = C.cyan) {
  closeGroup();
  ensureNewline();
  console.log(color + C.bold + `[PI][${phase}/${call}] ` + icon + " " + text + C.reset);
}

function oneLine(value, limit = 110) {
  const line = String(redact(value ?? "")).replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

function detailLines(text, color = C.dim) {
  // Prefix untrusted tool output so it cannot become a GitHub workflow command.
  for (const line of String(text).split(/\r\n|\r|\n/)) console.log("  " + color + line + C.reset);
}

function nextDiagnosticId(kind) {
  const safe = value => String(value).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${kind}-${process.pid}-${safe(phase)}-${safe(call)}-${++diagnosticNumber}`;
}

function checkSummary(result) {
  let check = result?.details;
  if (!check || typeof check !== "object" || typeof check.status !== "string") {
    try { check = JSON.parse(String(extractResultText(result))); }
    catch { return null; }
  }
  if (!check || typeof check !== "object" || typeof check.status !== "string" || typeof check.kind !== "string") return null;
  const failures = Array.isArray(check.diagnostics) ? check.diagnostics.length : 0;
  const exit = check.exit_code == null ? "unknown" : check.exit_code;
  const elapsed = Number.isFinite(check.duration_ms) ? duration(check.duration_ms) : "unknown";
  const note = typeof check.summary === "string" ? ` summary=${oneLine(check.summary, 110)}` : "";
  return `[PI][check] ${check.kind} ${check.status} exit=${exit} failures=${failures} duration=${elapsed}${note}`;
}

function printToolDetails(title, args, result, isError) {
  const safeArgs = args == null ? null : stringify(args, Number.MAX_SAFE_INTEGER);
  const completeOutput = result == null ? null : String(extractResultText(result));
  const needsArtifact = isError || (safeArgs?.length ?? 0) > ARGS_DISPLAY_CHARS || (completeOutput?.length ?? 0) > RESULT_DISPLAY_CHARS;
  const diagnosticId = needsArtifact ? nextDiagnosticId("event") : null;
  const hasArtifact = needsArtifact && appendDiagnostic(diagnosticsFile, {
    id: diagnosticId,
    at: new Date().toISOString(),
    phase,
    call,
    type: isError ? "tool_failure" : "truncated_tool_detail",
    title,
    arguments: args ?? null,
    result: result ?? null,
  });
  if (typeof result?.details?.kind === "string" || title.startsWith("run_check") || title.startsWith("retry_last_failed_check")) {
    const summary = checkSummary(result);
    if (summary) {
      console.log((/ (?:fail|timeout|infra_error) /.test(summary) ? C.red : C.cyan) + summary + C.reset);
      const check = result?.details;
      if (check?.kind && check?.status) lastRelevantCheck = `${check.kind}:${check.status}`;
      else lastRelevantCheck = summary.match(/^\[PI\]\[check\] (\S+ \S+)/)?.[1]?.replace(" ", ":") ?? lastRelevantCheck;
    }
  }
  lastRelevantTool = title;
  // GitHub's raw log only folds one level deep, so a tool call gets a single
  // group (or, with nothing to show, a single plain line) titled with
  // everything useful for scanning without expanding it.
  if (args == null && result == null) {
    heading(isError ? "✗" : "✓", title, isError ? C.red : C.green);
    return;
  }
  if (isError) heading("✗", title, C.red);
  else startGroup("✓ " + title, C.green);
  try {
    if (args != null) {
      console.log(C.dim + "Arguments:" + C.reset);
      detailLines(truncate(safeArgs, ARGS_DISPLAY_CHARS), C.magenta);
      if (safeArgs.length > ARGS_DISPLAY_CHARS) detailLines(`[PI][details] truncated ${safeArgs.length} -> ${ARGS_DISPLAY_CHARS} chars; full sanitized event ${diagnosticId} in ${hasArtifact ? diagnosticsFile.split(/[\\/]/).at(-1) : "diagnostic artifact unavailable"}`);
    }
    if (result != null) {
      const output = truncate(completeOutput, RESULT_DISPLAY_CHARS);
      if (output.trim()) {
        console.log(C.dim + "Result:" + C.reset);
        detailLines(output, isError ? C.red : C.dim);
        if (completeOutput.length > RESULT_DISPLAY_CHARS) detailLines(`[PI][details] truncated ${completeOutput.length} -> ${RESULT_DISPLAY_CHARS} chars; full sanitized event ${diagnosticId} in ${hasArtifact ? diagnosticsFile.split(/[\\/]/).at(-1) : "diagnostic artifact unavailable"}`);
      }
    }
  } finally {
    if (!isError) closeGroup();
  }
}

function reportFailureDiagnostic(runStatus) {
  let failure;
  try {
    failure = runtimeFailureFile && existsSync(runtimeFailureFile)
      ? JSON.parse(readFileSync(runtimeFailureFile, "utf8"))
      : { stage: phase, failure_code: "RUNTIME_FAILURE_METADATA_UNAVAILABLE", checkpoint: {} };
    const id = nextDiagnosticId("runtime-failure");
    const stored = appendDiagnostic(diagnosticsFile, { id, at: new Date().toISOString(), phase, call, type: "runtime_failure", failure });
    const lifecycle = `${failure.stage ?? phase}/${call}`;
    const category = oneLine(failure.failure_code ?? failure.code ?? failure.reason ?? "runtime_failure_metadata_unavailable", 100);
    const finalStatus = String(failure.failure_code ?? "").includes("BLOCKED") ? "blocked"
      : String(failure.failure_code ?? "").includes("CANCEL") ? "cancelled"
        : failure.failure_code === "RUNTIME_FAILURE_METADATA_UNAVAILABLE" ? runStatus
          : "failed";
    const preserved = failure.checkpoint?.worktree_preserved === true ? "true" : failure.checkpoint?.worktree_preserved === false ? "false" : "unknown";
    const detail = stored ? `${diagnosticsFile.split(/[\\/]/).at(-1)}#${id}` : "unavailable";
    const usage = measuredResponses ? usageSummary({ ...totals, cacheReadKnownResponses, cacheReadUnknownResponses }) : "tokens unavailable";
    const failureSummary = `[PI][failure] lifecycle=${lifecycle} status=${finalStatus} category=${category} last_tool=${oneLine(lastRelevantTool, 100)} last_check=${lastRelevantCheck} worktree_preserved=${preserved} usage="${usage}" diagnostics=${detail}`;
    console.log(C.red + failureSummary + C.reset);
  } catch {
    const id = nextDiagnosticId("runtime-failure");
    const stored = appendDiagnostic(diagnosticsFile, { id, at: new Date().toISOString(), phase, call, type: "runtime_failure_metadata_invalid" });
    const usage = measuredResponses ? usageSummary({ ...totals, cacheReadKnownResponses, cacheReadUnknownResponses }) : "tokens unavailable";
    console.log(C.red + `[PI][failure] lifecycle=${phase}/${call} status=failed category=RUNTIME_FAILURE_METADATA_INVALID last_tool=${oneLine(lastRelevantTool, 100)} last_check=${lastRelevantCheck} worktree_preserved=unknown usage="${usage}" diagnostics=${stored ? `${diagnosticsFile.split(/[\\/]/).at(-1)}#${id}` : "unavailable"}` + C.reset);
  }
}

// Child sessions append their own per-response records to the metrics file, including ones that
// ended in failure, timeout or cancellation. Replay them into the job log (once) so the usage
// collector, which only reads logs, attributes them to this root stage.
function replayDescendantMetrics() {
  const file = process.env.PI_METRICS_FILE;
  if (!file || !existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"descendant":true')) continue;
    try {
      if (JSON.parse(line).descendant === true) console.log(`PI_METRIC ${line}`);
    } catch { /* ignore a torn line */ }
  }
}

function reportFinal(status) {
  if (reportedFinal) return;
  reportedFinal = true;
  replayDescendantMetrics();
  closeGroup();
  const elapsed = Date.now() - sessionStarted;
  heading(status === "completed" ? "■" : "◼", `Agent ${status} · ${duration(elapsed)}`, status === "completed" ? C.green : C.yellow);
  console.log(C.gray + `Model totals (${measuredResponses} responses): ${measuredResponses ? usageSummary({ ...totals, cacheReadKnownResponses, cacheReadUnknownResponses }) : "tokens unavailable"} · response time ${duration(totalResponseMs)} · tools ${toolCount}` + C.reset);
  if (status !== "completed") {
    console.log(C.yellow + "Only completed model responses are counted." + C.reset);
    reportFailureDiagnostic(status);
  }
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
  lines.push(`**Tokens:** ${measuredResponses ? usageSummary({ ...totals, cacheReadKnownResponses, cacheReadUnknownResponses }) : "tokens unavailable"}`, "");
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
      lastAgentEndSeen = false;
      heading("▶", "Agent started", C.green);
      break;
    case "turn_start":
      responseStarted = Date.now();
      firstTokenAt = null;
      thinkingStreamed = false;
      textStreamed = false;
      assistantMessageStarted = false;
      streamKind = null;
      lastUsage = null;
      responseNumber += 1;
      currentTurn = { number: responseNumber, metaLine: null, thinking: "", response: "", tools: [] };
      turns.push(currentTurn);
      heading("◉", `Model #${responseNumber} · ${new Date().toISOString().slice(11, 19)} UTC`, C.blue);
      break;
    case "message_start":
      if (event.message?.role === "assistant") {
        assistantMessageStarted = true;
        if (responseStarted == null) responseStarted = Date.now();
      }
      break;
    case "message_update": {
      const update = event.assistantMessageEvent ?? {};
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        const delta = typeof update.delta === "string" ? update.delta : "";
        if (delta) {
          firstTokenAt ??= Date.now();
          recordActivity("model_delta", { stream: update.type === "thinking_delta" ? "thinking" : "text" });
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
      const rawUsage = message.usage ?? lastUsage;
      const providerTelemetry = providerTelemetryFor(call, responseNumber);
      const usage = usageWithProviderCacheTelemetry(rawUsage, providerTelemetry);
      if (usage && Object.values(usage).some(Number.isFinite)) {
        for (const key of Object.keys(totals)) {
          if (Number.isFinite(usage[key])) totals[key] += usage[key];
        }
        if (usage.cacheReadKnown === true) cacheReadKnownResponses += 1;
        else cacheReadUnknownResponses += 1;
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
      if (usage && Object.values(usage).some(Number.isFinite)) {
        const fields = {
          ...Object.fromEntries(Object.keys(totals).filter((key) => Number.isFinite(usage[key])).map((key) => [key, usage[key]])),
          cacheReadKnown: usage.cacheReadKnown === true,
        };
        const failureSignature = runtimeFailureSignature();
        if (failureSignature !== runtimeFailureSignatureSeen) {
          runtimeFailureSignatureSeen = failureSignature;
          runtimeFailureSettlementClaimed = false;
        }
        const syntheticSettlement =
          !assistantMessageStarted &&
          firstTokenAt == null &&
          (!Array.isArray(message.content) || message.content.length === 0) &&
          ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
            .every(key => !Number.isFinite(usage[key]) || usage[key] === 0) &&
          Boolean(failureSignature) &&
          !runtimeFailureSettlementClaimed;
        if (syntheticSettlement) runtimeFailureSettlementClaimed = true;
        recordMetric({
          issue: issue ?? 0,
          phase,
          call,
          response: responseNumber,
          usage: fields,
          responseMs: elapsed,
          ttftMs: providerTelemetry?.ttftMs ?? (firstTokenAt == null || responseStarted == null ? null : Math.max(0, firstTokenAt - responseStarted)),
          providerResponseMs: providerTelemetry?.responseMs ?? null,
          providerPromptTokens: providerTelemetry?.prompt_tokens ?? null,
          providerCachedTokens: providerTelemetry?.cached_tokens ?? null,
          cacheTelemetry: providerTelemetry?.cache_telemetry ?? (usage.cacheReadKnown ? "sdk-reported" : "unknown"),
          ...(syntheticSettlement
            ? { synthetic: true, record_type: 'synthetic_settlement' }
            : {}),
        });
        if (call === "main") {
          console.log(`PI_MAIN_PROVIDER_TELEMETRY ${JSON.stringify({
            request: responseNumber,
            promptTokens: providerTelemetry?.prompt_tokens ?? usage.input ?? null,
            cachedTokens: providerTelemetry?.cached_tokens ?? (usage.cacheReadKnown ? usage.cacheRead ?? null : null),
            cacheTelemetry: providerTelemetry?.cache_telemetry ?? (usage.cacheReadKnown ? "sdk-reported" : "unknown"),
            ttftMs: providerTelemetry?.ttftMs ?? (firstTokenAt == null || responseStarted == null ? null : Math.max(0, firstTokenAt - responseStarted)),
            responseMs: providerTelemetry?.responseMs ?? elapsed,
          })}`);
        }
      } else {
        // A completed response with no provider usage is an unknown, not an absent record.
        recordMetric({ issue: issue ?? 0, phase, call, response: responseNumber, usage: null, reason: "provider_usage_unavailable", responseMs: elapsed });
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
      lastRelevantTool = name;
      recordActivity("tool_start", { tool: name });
      toolCount += 1;
      heading("🔧", name + (hint ? " · " + oneLine(hint) : ""), C.magenta);
      break;
    }
    case "tool_execution_end": {
      const started = activeTools.get(event.toolCallId);
      activeTools.delete(event.toolCallId);
      recordActivity("tool_end", { tool: event.toolName ?? started?.name ?? "unknown" });
      const name = event.toolName ?? started?.name ?? "unknown";
      const isError = Boolean(event.isError);
      const ms = started?.at == null ? null : Date.now() - started.at;
      const took = ms == null ? "" : ` · ${duration(ms)}`;
      const hint = toolSummary(name, started?.args);
      const title = name + (hint ? " · " + oneLine(hint, 80) : "") + (isError ? " · failed" : "") + took;
      if (name === "subagent" && !isError) {
        const usage = finalizedToolUsage(event.result);
        if (usage) {
          subagentMetricNumber += 1;
          recordMetric({
            issue: issue ?? 0,
            phase,
            call: "subagent",
            aggregate: true,
            response: subagentMetricNumber,
            agent: typeof started?.args?.agent === "string" ? started.args.agent : undefined,
            usage,
            responseMs: ms,
          });
        }
      }
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
      {
        const fullEvent = stringify(event, Number.MAX_SAFE_INTEGER);
        const id = nextDiagnosticId("extension-error");
        const stored = appendDiagnostic(diagnosticsFile, { id, at: new Date().toISOString(), phase, call, type: "extension_error", event });
        heading("✗", "Extension error", C.red);
        detailLines(truncate(fullEvent, 4000), C.red);
        if (fullEvent.length > 4000) detailLines(`[PI][details] truncated ${fullEvent.length} -> 4000 chars; full sanitized event ${id} in ${stored ? diagnosticsFile.split(/[\\/]/).at(-1) : "diagnostic artifact unavailable"}`);
      }
      break;
    case "agent_end": {
      closeGroup();
      lastAgentEndSeen = true;
      const finalText = finalAssistantText(event.messages);
      if (finalText.trim() && !streamedText.trimEnd().endsWith(finalText.trimEnd())) {
        console.log();
        console.log(C.bold + "Final response" + C.reset);
        detailLines(truncate(redact(finalText), 12000));
      }
      // agent_before_settle may immediately continue the same Pi session. Do
      // not freeze totals or the Job Summary on this intermediate agent_end.
      heading("◇", "Agent pass settled", C.green);
      break;
    }
  }
}
flushStream(true);
reportFinal(lastAgentEndSeen ? "completed" : "interrupted");
if (!reasoningAvailable) console.log(C.gray + "Thinking text: not provided by the model" + C.reset);
divider();

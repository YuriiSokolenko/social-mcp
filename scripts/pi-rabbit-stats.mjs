#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Aggregates a rabbit-logger `rabbit-raw.jsonl` (streamed chat completions)
// into per-turn outcomes so harness changes can be judged on data:
// how many turns were cut by max_tokens, how much generation time that cost,
// which tools dominate model time, and how many tool calls had unusable args.
// Usage: node scripts/pi-rabbit-stats.mjs <rabbit-raw.jsonl> [--since ISO]

function newTurn() {
  return { calls: new Map(), reasoning: 0, content: 0, finish: null, usage: {}, timings: {}, error: false };
}

export function classify(turn) {
  if (turn.error) return "error";
  if (turn.calls.size) return "tool_call";
  if (turn.finish === "length") return "truncated";
  if (turn.reasoning && !turn.content) return "reasoning_only";
  if (turn.content) return "text_only";
  return "empty";
}

function argsParse(args) {
  try { JSON.parse(args || "{}"); return true; } catch { return false; }
}

export function summarize(records, { since = null } = {}) {
  const turns = new Map();
  for (const rec of records) {
    if (since && rec.time < since) continue;
    const turn = turns.get(rec.id) ?? newTurn();
    turns.set(rec.id, turn);
    if (rec.direction === "request") {
      const body = rec.body ?? {};
      turn.requested = true;
      turn.maxTokens = body.max_tokens ?? body.max_completion_tokens ?? null;
    } else if (rec.direction === "response_error") {
      turn.error = true;
    } else if (rec.direction === "response_chunk" || rec.direction === "response") {
      const body = rec.body ?? {};
      for (const choice of body.choices ?? []) {
        const delta = choice.delta ?? choice.message ?? {};
        turn.reasoning += (delta.reasoning_content ?? "").length;
        turn.content += (delta.content ?? "").length;
        for (const [i, call] of (delta.tool_calls ?? []).entries()) {
          const entry = turn.calls.get(call.index ?? i) ?? { name: "", args: "" };
          entry.name += call.function?.name ?? "";
          entry.args += call.function?.arguments ?? "";
          turn.calls.set(call.index ?? i, entry);
        }
        if (choice.finish_reason) turn.finish = choice.finish_reason;
      }
      if (body.usage) turn.usage = body.usage;
      if (body.timings) turn.timings = body.timings;
    }
  }

  const rows = [...turns.values()].filter((t) => t.requested);
  const outcomes = {};
  const byCeiling = new Map();
  const byTool = new Map();
  let genSeconds = 0;
  let truncatedSeconds = 0;
  let truncatedTokens = 0;
  let outputTokens = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  const badArgs = {};

  for (const turn of rows) {
    const kind = classify(turn);
    outcomes[kind] = (outcomes[kind] ?? 0) + 1;
    const seconds = (turn.timings.predicted_ms ?? 0) / 1000;
    const out = turn.usage.completion_tokens ?? 0;
    genSeconds += seconds;
    outputTokens += out;
    promptTokens += turn.usage.prompt_tokens ?? 0;
    cachedTokens += turn.usage.prompt_tokens_details?.cached_tokens ?? 0;
    if (kind === "truncated") { truncatedSeconds += seconds; truncatedTokens += out; }

    const ceiling = byCeiling.get(turn.maxTokens ?? "none") ?? { turns: 0, truncated: 0 };
    ceiling.turns += 1;
    if (turn.finish === "length") ceiling.truncated += 1;
    byCeiling.set(turn.maxTokens ?? "none", ceiling);

    for (const call of turn.calls.values()) {
      const tool = byTool.get(call.name) ?? { calls: 0, seconds: 0 };
      tool.calls += 1;
      tool.seconds += seconds / turn.calls.size;
      byTool.set(call.name, tool);
      if (!argsParse(call.args)) badArgs[call.name] = (badArgs[call.name] ?? 0) + 1;
    }
  }

  return {
    turns: rows.length,
    outcomes,
    outputTokens,
    promptTokens,
    cacheRatio: promptTokens ? cachedTokens / promptTokens : 0,
    genSeconds,
    truncated: { turns: outcomes.truncated ?? 0, outputTokens: truncatedTokens, genSeconds: truncatedSeconds },
    byCeiling: [...byCeiling].map(([ceiling, v]) => ({ ceiling, ...v })).sort((a, b) => String(a.ceiling).localeCompare(String(b.ceiling), undefined, { numeric: true })),
    byTool: [...byTool].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.seconds - a.seconds),
    unparseableToolArgs: badArgs,
  };
}

export function formatSummary(s) {
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const lines = [
    `turns: ${s.turns}  outcomes: ${JSON.stringify(s.outcomes)}`,
    `output tokens: ${s.outputTokens}  prompt tokens: ${s.promptTokens} (cached ${pct(s.cacheRatio, 1)})  generation: ${(s.genSeconds / 3600).toFixed(2)} h`,
    `truncated by max_tokens: ${s.truncated.turns} turns (${pct(s.truncated.turns, s.turns)}), ${s.truncated.outputTokens} tokens, ${(s.truncated.genSeconds / 3600).toFixed(2)} h`,
    "",
    "max_tokens  turns  truncated",
    ...s.byCeiling.map((c) => `${String(c.ceiling).padEnd(10)}  ${String(c.turns).padStart(5)}  ${c.truncated} (${pct(c.truncated, c.turns)})`),
    "",
    "tool                         calls  model seconds",
    ...s.byTool.slice(0, 15).map((t) => `${t.tool.padEnd(28)} ${String(t.calls).padStart(5)}  ${Math.round(t.seconds)}`),
    "",
    `unparseable tool args: ${JSON.stringify(s.unparseableToolArgs)}`,
  ];
  return lines.join("\n");
}

async function* readJsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip a partial trailing line */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, flag, since] = process.argv.slice(2);
  if (!path) {
    console.error("usage: pi-rabbit-stats.mjs <rabbit-raw.jsonl> [--since ISO]");
    process.exit(2);
  }
  const records = [];
  for await (const rec of readJsonl(path)) records.push(rec);
  console.log(formatSummary(summarize(records, { since: flag === "--since" ? since : null })));
}

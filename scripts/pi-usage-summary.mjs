#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";

// A run this large or slow almost always means the model got stuck repeating
// itself rather than doing proportionally more useful work: normal Architect
// keep/revise decisions take 10-16 responses and a few hundred seconds, and
// even a thorough split should have room under the loop guard's own turn
// budget (PI_MAX_TURNS) and the job's timeout-minutes. These defaults sit
// above both, so this only fires once a run is clearly past legitimate use.
export function usageWarning(responses, modelSeconds, {
  maxResponses = Number(process.env.PI_USAGE_WARN_RESPONSES ?? 120),
  maxSeconds = Number(process.env.PI_USAGE_WARN_SECONDS ?? 5400),
} = {}) {
  if (responses > maxResponses) {
    return `Pi usage: ${responses} responses exceeds the ${maxResponses}-response guard threshold; `
      + "the run likely got stuck repeating tool calls instead of converging.";
  }
  if (modelSeconds > maxSeconds) {
    return `Pi usage: ${modelSeconds.toFixed(1)}s of model time exceeds the ${maxSeconds}s guard threshold; `
      + "the run likely got stuck repeating tool calls instead of converging.";
  }
  return null;
}

const file = process.env.PI_METRICS_FILE;
const summary = process.env.GITHUB_STEP_SUMMARY;
const issue = process.env.PI_ISSUE;
const phase = process.env.PI_PHASE ?? "agent";
const records = file && existsSync(file)
  ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  })
  : [];
const unique = new Map(records.map((record) => [`${record.call}:${record.response}`, record]));
const totals = { input: 0, output: 0, total: 0, responseMs: 0 };
const calls = new Map();
for (const record of unique.values()) {
  const usage = record.usage ?? {};
  const row = calls.get(record.call) ?? { responses: 0, input: 0, output: 0, total: 0, responseMs: 0 };
  for (const target of [row, totals]) {
    target.input += usage.input ?? 0;
    target.output += usage.output ?? 0;
    target.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
    target.responseMs += record.responseMs ?? 0;
  }
  row.responses += 1;
  calls.set(record.call, row);
}
const n = (value) => value.toLocaleString("en-US");
const lines = [
  `### Pi usage · ${issue ? `issue #${issue}` : "issue unavailable"} · ${phase}`,
  "",
  "| Call | Responses | Input | Output | Total tokens | Model time |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
];
for (const [call, row] of calls) {
  lines.push(`| ${call} | ${row.responses} | ${n(row.input)} | ${n(row.output)} | ${n(row.total)} | ${(row.responseMs / 1000).toFixed(1)} s |`);
}
lines.push(`| **Total** | **${unique.size}** | **${n(totals.input)}** | **${n(totals.output)}** | **${n(totals.total)}** | **${(totals.responseMs / 1000).toFixed(1)} s** |`);
lines.push("", "Only completed model responses are included. Runner time and all attempts are in the repository usage table.", "");
const warning = usageWarning(unique.size, totals.responseMs / 1000);
if (warning) lines.push(`> [!WARNING]`, `> ${warning}`, "");
if (summary) appendFileSync(summary, lines.join("\n") + "\n");
console.log(`Pi usage: ${unique.size} responses · ${n(totals.total)} tokens · ${(totals.responseMs / 1000).toFixed(1)} s model time`);
if (warning) console.log(`::warning::${warning}`);

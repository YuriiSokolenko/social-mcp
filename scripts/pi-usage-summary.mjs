#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";

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
if (summary) appendFileSync(summary, lines.join("\n") + "\n");
console.log(`Pi usage: ${unique.size} responses · ${n(totals.total)} tokens · ${(totals.responseMs / 1000).toFixed(1)} s model time`);

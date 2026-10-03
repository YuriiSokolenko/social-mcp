#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { completenessNote, summarizeUsage } from "./pi-common/usage-ledger.mjs";

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
    return `Pi usage: ${responses} provider responses exceeds the ${maxResponses}-response guard threshold; `
      + "the run likely got stuck repeating tool calls instead of converging.";
  }
  if (modelSeconds > maxSeconds) {
    return `Pi usage: ${modelSeconds.toFixed(1)}s of provider response time exceeds the ${maxSeconds}s guard threshold; `
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
const ledger = summarizeUsage(records);
const { calls, totals } = ledger;
const n = (value) => value.toLocaleString("en-US");
const lines = [
  `### Pi usage · ${issue ? `issue #${issue}` : "issue unavailable"} · ${phase}`,
  "",
  "| Call | Logical usage records | Provider responses | Fresh input | Output | Cache read | Cache write | Total tokens | Known provider response time | Delegated lifecycle time |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
];
for (const [call, row] of calls) {
  lines.push(`| ${call} | ${row.responses} | ${row.providerResponses} | ${n(row.input)} | ${n(row.output)} | ${n(row.cacheRead)} | ${n(row.cacheWrite)} | ${n(row.total)} | ${(row.providerResponseMs / 1000).toFixed(1)} s | ${(row.delegatedLifecycleMs / 1000).toFixed(1)} s |`);
}
lines.push(`| **Total${ledger.complete ? "" : " (known lower bound)"}** | **${totals.responses}** | **${totals.providerResponses}** | **${n(totals.input)}** | **${n(totals.output)}** | **${n(totals.cacheRead)}** | **${n(totals.cacheWrite)}** | **${n(totals.total)}** | **${(totals.providerResponseMs / 1000).toFixed(1)} s** | **${(totals.delegatedLifecycleMs / 1000).toFixed(1)} s** |`);
lines.push("", "Logical usage records preserve the existing metric-record accounting; delegated planner/coding lifecycles may aggregate several provider turns into one record. Provider turn counts may come from lifecycle roll-ups, but provider response time is counted only from explicit per-response responseMs measurements.", "Delegated lifecycle time comes from delegate durationMs and is shown separately because it may include queueing, tool execution and other runtime work; it is not added to provider response time.", "Total tokens include repeated cache reads. Fresh input/output and cache traffic are shown separately so cumulative cached context is not mistaken for newly consumed context.", "");
lines.push(`> ${completenessNote(ledger)}`, "");
const main = calls.get("main") ?? { responses: 0, providerResponses: 0, responseMs: 0, providerResponseMs: 0 };
const warning = usageWarning(main.providerResponses ?? main.responses, (main.providerResponseMs ?? main.responseMs) / 1000);
if (warning) lines.push(`> [!WARNING]`, `> ${warning}`, "");
if (summary) appendFileSync(summary, lines.join("\n") + "\n");
console.log(`Pi usage${ledger.complete ? "" : " (INCOMPLETE, known lower bound)"}: ${totals.responses} logical usage records · ${totals.providerResponses} provider responses · fresh ${n(totals.input)} in / ${n(totals.output)} out · cache read ${n(totals.cacheRead)} · total ${n(totals.total)} · ${(totals.providerResponseMs / 1000).toFixed(1)} s known provider response time · ${(totals.delegatedLifecycleMs / 1000).toFixed(1)} s delegated lifecycle time`);
if (!ledger.complete) console.log(`::warning::${completenessNote(ledger)}`);
if (warning) console.log(`::warning::${warning}`);

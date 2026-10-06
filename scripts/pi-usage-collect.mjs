#!/usr/bin/env node

// Rebuild one CSV from completed workflow job logs. Each run/attempt is an
// idempotent record; issue rows are derived from those records on every update.
import { readFileSync } from "node:fs";
import { githubClient } from "./pi-common/github-api.mjs";
import { workflowFile } from "./pi-common/project-config.mjs";
import { summarizeUsage } from "./pi-common/usage-ledger.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
let run = event.workflow_run;
const path = "reports/pi-usage.csv";
const metricsBranch = "pi-metrics";
const columns = ["scope", "issue", "phase", "run_id", "attempt", "status", "responses", "responses_semantics", "provider_responses", "input", "output", "cache_read", "cache_write", "total_tokens", "model_seconds", "runner_seconds", "complete", "unknown_requests", "url", "delegated_lifecycle_seconds"];
const preSemanticsColumns = columns.filter((column) => column !== "responses_semantics");
const preProviderColumns = preSemanticsColumns.filter((column) => column !== "provider_responses");
const previousColumns = preProviderColumns.filter((column) => column !== "delegated_lifecycle_seconds");
const legacyColumns = previousColumns.filter((column) => column !== "complete" && column !== "unknown_requests");
const { raw: request } = githubClient({ repo, token });

function events(log, prefix) {
  return log.split("\n").flatMap((line) => {
    // Pi output starts at column zero after the GitHub timestamp. Assistant and
    // tool output is indented by the renderer, so it cannot forge metric lines.
    const match = line.match(new RegExp(`^(?:\\uFEFF?\\d{4}-\\d\\d-\\d\\dT[^ ]+Z )?${prefix} (\\{[^\\r\\n]*\\})\\r?$`));
    if (!match) return [];
    try { return [JSON.parse(match[1])]; } catch { return []; }
  });
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseCsv(source) {
  const lines = source.trim().split("\n");
  const headerLine = lines[0];
  const header = headerLine === columns.join(",")
    ? columns
    : headerLine === preSemanticsColumns.join(",")
      ? preSemanticsColumns
      : headerLine === preProviderColumns.join(",")
        ? preProviderColumns
        : headerLine === previousColumns.join(",")
          ? previousColumns
          : headerLine === legacyColumns.join(",")
            ? legacyColumns
            : null;
  if (!header) throw new Error("Unexpected usage CSV header");
  return lines.slice(1).filter(Boolean).map((line) => {
    // All values in this file are numeric, fixed labels or URLs with no commas.
    const fields = line.split(",");
    if (fields.length !== header.length) throw new Error("Invalid usage CSV row");
    // Older rows cannot prove completeness and pre-#463 rows have no delegated lifecycle timing.
    const parsed = Object.fromEntries(header.map((column, i) => [column, fields[i]]));
    return {
      complete: "unknown", unknown_requests: "", delegated_lifecycle_seconds: "",
      // Rows written before this schema cannot be classified reliably: some historical writers
      // stored logical records in responses, while the short-lived #470 implementation stored
      // provider responses there. Preserve the cell but mark its meaning unknown.
      responses_semantics: header.includes("responses_semantics") ? parsed.responses_semantics : "legacy_unknown",
      provider_responses: header.includes("provider_responses") ? parsed.provider_responses : "",
      ...parsed,
    };
  });
}

function csv(rows) {
  return [columns.join(","), ...rows.map((row) => columns.map((key) => row[key] ?? "").join(",")), ""].join("\n");
}

if (!run && /^\d+$/.test(process.env.MANUAL_RUN_ID ?? "")) {
  const response = await request(`/actions/runs/${process.env.MANUAL_RUN_ID}`);
  if (!response.ok) throw new Error(`Failed to load requested workflow run: ${response.status}`);
  run = await response.json();
}
if (!run?.id || !run?.run_attempt || run.status !== "completed") throw new Error("Expected a completed Pi workflow run");
const trustedWorkflows = new Set(
  ["implementer", "reviewer", "repair", "architect", "dispatcher", "triage"].map(role => `.github/workflows/${workflowFile(role)}`),
);
if (run.head_repository?.full_name !== repo || !trustedWorkflows.has(run.path)) {
  throw new Error("The requested run is not a trusted Pi workflow from this repository");
}

const jobsResponse = await request(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
if (!jobsResponse.ok) throw new Error(`Failed to list jobs: ${jobsResponse.status}`);
const jobs = (await jobsResponse.json()).jobs.filter((job) => ["pi", "review", "fix", "architect", "dispatcher", "triage"].includes(job.name));
const newRows = [];
for (const job of jobs) {
  if (job.conclusion === "skipped") {
    console.log(`Job ${job.id} was skipped; no log to collect`);
    continue;
  }
  let log;
  for (let retry = 0; retry < 5; retry++) {
    const response = await request(`/actions/jobs/${job.id}/logs`);
    if (response.ok) { log = await response.text(); break; }
    if (retry === 4) {
      if (response.status === 404) {
        console.log(`Job ${job.id} log is unavailable after completion; skipping usage collection for this job`);
        break;
      }
      throw new Error(`Failed to fetch job ${job.id} logs: ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (retry + 1)));
  }
  if (log == null) continue;
  const task = events(log, "PI_TASK")[0];
  const systemPhase = job.name === "dispatcher" || job.name === "triage" ? job.name : null;
  if ((!task || !integer(task.issue)) && !systemPhase) {
    console.log(`Job ${job.id} did not start a Pi issue session; skipping`);
    continue;
  }
  const issue = task?.issue ?? 0;
  const phase = task?.phase ?? systemPhase;
  const metrics = events(log, "PI_METRIC").filter((metric) => !task || metric.issue === issue);
  const ledger = summarizeUsage(metrics);
  const totals = {
    input: ledger.totals.input, output: ledger.totals.output,
    cache_read: ledger.totals.cacheRead, cache_write: ledger.totals.cacheWrite,
    total_tokens: ledger.totals.total,
    model_seconds: ledger.totals.providerResponseMs / 1000,
    delegated_lifecycle_seconds: ledger.totals.delegatedLifecycleMs / 1000,
  };
  const runnerSeconds = job.started_at && job.completed_at
    ? Math.max(0, Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000)) : 0;
  newRows.push({
    scope: "attempt", issue, phase, run_id: run.id,
    attempt: run.run_attempt, status: job.conclusion ?? "unknown",
    responses: ledger.totals.responses,
    responses_semantics: "logical",
    provider_responses: ledger.totals.providerResponses,
    ...totals,
    model_seconds: totals.model_seconds.toFixed(1),
    delegated_lifecycle_seconds: totals.delegated_lifecycle_seconds.toFixed(1),
    runner_seconds: runnerSeconds,
    complete: ledger.complete, unknown_requests: ledger.unknown.length,
    url: `https://github.com/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
  });
}

if (!newRows.length) {
  console.log("No Pi issue sessions found in completed run");
  process.exit(0);
}

for (let retry = 0; retry < 8; retry++) {
  const current = await request(`/contents/${path}?ref=${metricsBranch}`);
  if (!current.ok && current.status !== 404) throw new Error(`Failed to read usage CSV: ${current.status}`);
  const body = current.ok ? await current.json() : null;
  const oldRows = body ? parseCsv(Buffer.from(body.content, "base64").toString("utf8")) : [];
  const attempts = new Map(oldRows.filter((row) => row.scope === "attempt").map((row) => [`${row.run_id}:${row.attempt}`, row]));
  for (const row of newRows) attempts.set(`${row.run_id}:${row.attempt}`, row);
  const issueTotals = new Map();
  for (const row of attempts.values()) {
    if (Number(row.issue) === 0) continue;
    const total = issueTotals.get(row.issue) ?? {
      scope: "issue", issue: row.issue, phase: "all", run_id: "", attempt: "", status: "",
      responses: 0, responses_semantics: "logical", provider_responses: 0,
      input: 0, output: 0, cache_read: 0, cache_write: 0,
      total_tokens: 0, model_seconds: 0, delegated_lifecycle_seconds: 0,
      runner_seconds: 0, complete: true, unknown_requests: 0, url: `https://github.com/${repo}/issues/${row.issue}`,
      _responses_known: true, _provider_responses_known: true,
    };
    if (String(row.responses_semantics) !== "logical") total._responses_known = false;
    if (String(row.provider_responses) === "") total._provider_responses_known = false;
    for (const key of ["input", "output", "cache_read", "cache_write", "total_tokens", "model_seconds", "delegated_lifecycle_seconds", "runner_seconds"]) {
      total[key] += Number(row[key]);
    }
    if (total._responses_known) total.responses += Number(row.responses);
    if (total._provider_responses_known) total.provider_responses += Number(row.provider_responses);
    total.unknown_requests += Number(row.unknown_requests) || 0;
    // An attempt whose completeness is unknown (legacy row) taints the issue total too.
    if (String(row.complete) !== "true") total.complete = false;
    issueTotals.set(row.issue, total);
  }
  const sortedIssues = [...issueTotals.values()].sort((a, b) => Number(a.issue) - Number(b.issue));
  for (const row of sortedIssues) {
    if (!row._responses_known) {
      row.responses = "";
      row.responses_semantics = "mixed_or_unknown";
    }
    if (!row._provider_responses_known) row.provider_responses = "";
    delete row._responses_known;
    delete row._provider_responses_known;
    row.model_seconds = row.model_seconds.toFixed(1);
    row.delegated_lifecycle_seconds = row.delegated_lifecycle_seconds.toFixed(1);
  }
  const sortedAttempts = [...attempts.values()].sort((a, b) => Number(a.run_id) - Number(b.run_id) || Number(a.attempt) - Number(b.attempt));
  const payload = {
    message: `chore: update Pi usage for run ${run.id} attempt ${run.run_attempt}`,
    content: Buffer.from(csv([...sortedIssues, ...sortedAttempts])).toString("base64"),
    branch: metricsBranch,
    ...(body ? { sha: body.sha } : {}),
  };
  const update = await request(`/contents/${path}`, "PUT", payload);
  if (update.ok) {
    console.log(`Updated ${path}: ${sortedIssues.length} issues, ${sortedAttempts.length} attempts`);
    process.exit(0);
  }
  if (![409, 422].includes(update.status)) throw new Error(`Failed to update usage CSV: ${update.status} ${await update.text()}`);
  await new Promise((resolve) => setTimeout(resolve, 400 * (retry + 1)));
}
throw new Error("Usage CSV update kept conflicting; retry the workflow");

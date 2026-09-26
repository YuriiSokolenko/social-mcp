#!/usr/bin/env node

// Rebuild one CSV from completed workflow job logs. Each run/attempt is an
// idempotent record; issue rows are derived from those records on every update.
import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
let run = event.workflow_run;
const path = "reports/pi-usage.csv";
const columns = ["scope", "issue", "phase", "run_id", "attempt", "status", "responses", "input", "output", "cache_read", "cache_write", "total_tokens", "model_seconds", "runner_seconds", "url"];
const api = `https://api.github.com/repos/${repo}`;

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  return response;
}

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
  if (lines[0] !== columns.join(",")) throw new Error("Unexpected usage CSV header");
  return lines.slice(1).filter(Boolean).map((line) => {
    // All values in this file are numeric, fixed labels or URLs with no commas.
    const fields = line.split(",");
    if (fields.length !== columns.length) throw new Error("Invalid usage CSV row");
    return Object.fromEntries(columns.map((column, i) => [column, fields[i]]));
  });
}

function csv(rows) {
  return [columns.join(","), ...rows.map((row) => columns.map((key) => row[key] ?? "").join(",")), ""].join("\n");
}

if (!run && /^\d+$/.test(process.env.MANUAL_RUN_ID ?? "")) {
  const response = await request(`${api}/actions/runs/${process.env.MANUAL_RUN_ID}`);
  if (!response.ok) throw new Error(`Failed to load requested workflow run: ${response.status}`);
  run = await response.json();
}
if (!run?.id || !run?.run_attempt || run.status !== "completed") throw new Error("Expected a completed Pi workflow run");
const trustedWorkflows = new Set([
  ".github/workflows/pi-issue-agent.yml",
  ".github/workflows/pi-pr-review.yml",
  ".github/workflows/pi-pr-fix.yml",
  ".github/workflows/pi-architect.yml",
  ".github/workflows/pi-dispatcher.yml",
  ".github/workflows/pi-triage.yml",
]);
if (run.head_repository?.full_name !== repo || !trustedWorkflows.has(run.path)) {
  throw new Error("The requested run is not a trusted Pi workflow from this repository");
}

const jobsResponse = await request(`${api}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
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
    const response = await request(`${api}/actions/jobs/${job.id}/logs`);
    if (response.ok) { log = await response.text(); break; }
    if (retry === 4) throw new Error(`Failed to fetch job ${job.id} logs: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * (retry + 1)));
  }
  const task = events(log, "PI_TASK")[0];
  const systemPhase = job.name === "dispatcher" || job.name === "triage" ? job.name : null;
  if ((!task || !integer(task.issue)) && !systemPhase) {
    console.log(`Job ${job.id} did not start a Pi issue session; skipping`);
    continue;
  }
  const issue = task?.issue ?? 0;
  const phase = task?.phase ?? systemPhase;
  const responses = new Map();
  for (const metric of events(log, "PI_METRIC")) {
    if (task && metric.issue !== issue || !integer(metric.response)) continue;
    responses.set(`${metric.call}:${metric.response}`, metric);
  }
  const totals = { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, model_seconds: 0 };
  for (const metric of responses.values()) {
    const usage = metric.usage ?? {};
    totals.input += integer(usage.input);
    totals.output += integer(usage.output);
    totals.cache_read += integer(usage.cacheRead);
    totals.cache_write += integer(usage.cacheWrite);
    totals.total_tokens += integer(usage.totalTokens ?? (integer(usage.input) + integer(usage.output)));
    totals.model_seconds += integer(metric.responseMs) / 1000;
  }
  const runnerSeconds = job.started_at && job.completed_at
    ? Math.max(0, Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000)) : 0;
  newRows.push({
    scope: "attempt", issue, phase, run_id: run.id,
    attempt: run.run_attempt, status: job.conclusion ?? "unknown", responses: responses.size,
    ...totals, model_seconds: totals.model_seconds.toFixed(1), runner_seconds: runnerSeconds,
    url: `https://github.com/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
  });
}

if (!newRows.length) {
  console.log("No Pi issue sessions found in completed run");
  process.exit(0);
}

for (let retry = 0; retry < 8; retry++) {
  const current = await request(`${api}/contents/${path}?ref=dev`);
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
      responses: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
      total_tokens: 0, model_seconds: 0, runner_seconds: 0, url: `https://github.com/${repo}/issues/${row.issue}`,
    };
    for (const key of ["responses", "input", "output", "cache_read", "cache_write", "total_tokens", "model_seconds", "runner_seconds"]) {
      total[key] += Number(row[key]);
    }
    issueTotals.set(row.issue, total);
  }
  const sortedIssues = [...issueTotals.values()].sort((a, b) => Number(a.issue) - Number(b.issue));
  for (const row of sortedIssues) row.model_seconds = row.model_seconds.toFixed(1);
  const sortedAttempts = [...attempts.values()].sort((a, b) => Number(a.run_id) - Number(b.run_id) || Number(a.attempt) - Number(b.attempt));
  const payload = {
    message: `chore: update Pi usage for run ${run.id} attempt ${run.run_attempt}`,
    content: Buffer.from(csv([...sortedIssues, ...sortedAttempts])).toString("base64"),
    branch: "dev",
    ...(body ? { sha: body.sha } : {}),
  };
  const update = await request(`${api}/contents/${path}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (update.ok) {
    console.log(`Updated ${path}: ${sortedIssues.length} issues, ${sortedAttempts.length} attempts`);
    process.exit(0);
  }
  if (![409, 422].includes(update.status)) throw new Error(`Failed to update usage CSV: ${update.status} ${await update.text()}`);
  await new Promise((resolve) => setTimeout(resolve, 400 * (retry + 1)));
}
throw new Error("Usage CSV update kept conflicting; retry the workflow");

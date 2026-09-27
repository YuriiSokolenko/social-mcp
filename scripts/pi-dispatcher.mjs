#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { githubClient } from "./pi-common/github-api.mjs";
import { readQueueContext } from "./pi-common/queue-context.mjs";
import { replaceIssueState } from "./pi-common/github-state.mjs";
import { ISSUE_ACTIVE, ISSUE_TERMINAL, PIPELINE_LABELS, inspectIssueState, validateIssueTransition } from "./pi-common/state-machine.mjs";
import { taskMetadata } from "./pi-common/task-metadata.mjs";
import { readPiJsonl } from "./pi-common/result-jsonl.mjs";

const { api: request, pages, ensureLabel, repo, dispatchWorkflow } = githubClient();
const api = (endpoint, options = {}) =>
  request(endpoint, options.method ?? "GET", options.body ? JSON.parse(options.body) : undefined);
function usage() {
  throw new Error("usage: pi-dispatcher.mjs prepare <context.json> | apply <pi-jsonl>");
}
const labels = issue => new Set(issue.labels.map(label => label.name));
async function transitionIssue(number, action) {
  const expected = await api(`/issues/${number}`);
  const target = validateIssueTransition(expected, action);
  await replaceIssueState({
    number, expected, target,
    load: n => api(`/issues/${n}`),
    patch: (n, labels) => api(`/issues/${n}`, { method: "PATCH", body: JSON.stringify({ labels }) }),
  });
}

const activeLabels = [...ISSUE_ACTIVE].filter(label => label !== PIPELINE_LABELS.architectReady);
const blockedLabels = [...ISSUE_TERMINAL, PIPELINE_LABELS.architectReady, PIPELINE_LABELS.epic];

export const issueMetadata = issue => { const metadata = taskMetadata(issue); return { priority: metadata.priority, dependencies: metadata.dependencies }; };
async function snapshot(includeQueue = false) {
  const [issues, prs] = await Promise.all([
    pages("/issues?state=open"),
    pages("/pulls?state=open"),
  ]);
  const allIssues = issues.filter(issue => !issue.pull_request);
  const openIssues = allIssues.filter(issue => issue.state === "open");
  const openPrIssues = new Set();
  for (const pr of prs) {
    if (pr.head.repo?.full_name !== repo || pr.base.ref !== "dev") continue;
    const match = pr.head.ref.match(/^pi\/issue-(\d+)$/);
    if (match) openPrIssues.add(Number(match[1]));
  }
  const active = new Set(openPrIssues);
  for (const issue of openIssues) {
    if (activeLabels.some(label => labels(issue).has(label))) active.add(issue.number);
  }
  const skipped = [];
  const candidates = [];
  for (const issue of openIssues.filter(item => labels(item).has(PIPELINE_LABELS.queued))) {
    let reason;
    const stateFindings = inspectIssueState(issue, { hasOpenPiPr: openPrIssues.has(issue.number) });
    if (stateFindings.length) reason = `inconsistent pipeline state: ${stateFindings.map(item => item.code).join(", ")}`;
    if (active.has(issue.number)) reason = "already active";
    else if (blockedLabels.some(label => labels(issue).has(label))) reason = "owned by a non-dispatchable pipeline state";
    let metadata;
    if (!reason) {
      try {
        metadata = issueMetadata(issue);
      } catch (error) { reason = error.message; }
    }
    if (!reason) {
      for (const number of metadata.dependencies) {
        const dependency = await api(`/issues/${number}`);
        if (dependency.pull_request || dependency.state !== "closed" || dependency.state_reason !== "completed") {
          reason = `dependency #${number} is not completed`;
          break;
        }
      }
    }
    if (reason) skipped.push({ issue: issue.number, reason });
    else candidates.push({ issue: issue.number, priority: metadata.priority, title: issue.title,
      body: issue.body ?? "", architect_child: /<!-- architect-parent:\d+; architect-key:[a-z][a-z0-9-]* -->/.test(issue.body ?? "") });
  }
  candidates.sort((a, b) => a.priority.localeCompare(b.priority) || a.issue - b.issue);
  const result = { active: [...active].sort((a, b) => a - b), candidates, skipped };
  if (includeQueue) result.queue = await readQueueContext(endpoint => api(endpoint), repo, openIssues, prs);
  return result;
}
export function finalText(jsonl) {
  return readPiJsonl(jsonl).finalText;
}
export function validateDispatch(result) {
  if (!Array.isArray(result.classifications) ||
      !result.classifications.every(item => Number.isSafeInteger(item?.issue) &&
        ["IMPLEMENT", "ARCHITECT"].includes(item?.decision))) {
    throw new Error("invalid dispatcher classifications");
  }
  const numbers = result.classifications.map(item => item.issue);
  if (new Set(numbers).size !== numbers.length) throw new Error("duplicate issue");
  return result;
}

export function classificationLists(result) {
  return {
    issues: result.classifications.filter(item => item.decision === "IMPLEMENT").map(item => item.issue),
    architect: result.classifications.filter(item => item.decision === "ARCHITECT").map(item => item.issue),
  };
}
export function dispatchFromJsonl(jsonl) {
  const { customResult, finalText: text } = readPiJsonl(jsonl, { customType: "dispatcher-result" });
  if (customResult) return validateDispatch(customResult);
  const lines = text.split(/\\r?\\n/).filter(line => line.startsWith("DISPATCH_RESULT: "));
  if (!lines.length) throw new Error("expected a DISPATCH_RESULT line");
  return validateDispatch(JSON.parse(lines.at(-1).slice("DISPATCH_RESULT: ".length)));
}
async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!["prepare", "apply"].includes(mode) || !file) usage();
  if (mode === "prepare") {
    await ensureLabel("dispatcher:ready", "d4c5f9", "Eligible for Pi dispatcher selection");
    await ensureLabel("architect:ready", "c5def5", "Needs Pi Architect to split the issue");
    const data = await snapshot(true);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log(`Dispatcher: ${data.active.length} active, ${data.candidates.length} ready candidates`);
    for (const item of data.skipped) console.log(`Skipped #${item.issue}: ${item.reason}`);
    return;
  }
  const result = dispatchFromJsonl(fs.readFileSync(file, "utf8"));
  const classified = classificationLists(result);
  const selected = result.classifications.map(item => item.issue);

  // The concurrency group serializes dispatcher jobs, but queued jobs can start
  // with stale trigger events. Always rebuild state after acquiring the runner
  // and treat GitHub state, not the triggering event, as the source of truth.
  const initial = await snapshot();
  if (selected.length !== initial.candidates.length ||
      initial.candidates.some(candidate => !selected.includes(candidate.issue))) {
    throw new Error("classify every eligible issue exactly once");
  }
  for (const { issue: number } of initial.candidates) {
    const state = await snapshot();

    // A previous serialized dispatcher may already have assigned this issue.
    // That is a successful no-op, not an error and must never emit a duplicate
    // workflow dispatch.
    if (state.active.includes(number)) {
      console.log(`Skipped #${number}: already assigned by an earlier dispatcher`);
      continue;
    }

    if (number !== state.candidates[0]?.issue) {
      console.log(`Skipped #${number}: no longer the next eligible issue`);
      continue;
    }

    if (classified.architect.includes(number)) {
      await transitionIssue(number, "architect-ready");
      // GITHUB_TOKEN label events cannot trigger another Actions workflow.
      // If the explicit dispatch fails, return ownership to the serialized
      // dispatcher instead of misclassifying an infrastructure failure as
      // architect/human work.
      try {
        await dispatchWorkflow("pi-architect.yml", { issue_number: String(number) });
      } catch (error) {
        try {
          await transitionIssue(number, "queued");
        } catch (rollbackError) {
          console.error(`Could not roll back architect:ready on #${number}: ${rollbackError}`);
        }
        throw error;
      }
      console.log(`Sent #${number} to Architect`);
      continue;
    }

    await transitionIssue(number, "ready");
    try {
      await dispatchWorkflow("pi-issue-agent.yml", { issue_number: String(number) });
    } catch (error) {
      try {
        await transitionIssue(number, "queued");
      } catch (rollbackError) {
        console.error(`Could not roll back pi:ready on #${number}: ${rollbackError}`);
      }
      throw error;
    }
    console.log(`Dispatched #${number}`);
  }
  if (!selected.length) console.log("Dispatcher selected no issues");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
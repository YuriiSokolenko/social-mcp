#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readQueueContext } from "./pi-queue-context.mjs";
import { ISSUE_ACTIVE, ISSUE_TERMINAL, PIPELINE_LABELS, inspectIssueState } from "./pi-state-machine.mjs";

const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
function usage() {
  throw new Error("usage: pi-dispatcher.mjs prepare <context.json> | apply <pi-jsonl>");
}
const base = `https://api.github.com/repos/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
async function api(endpoint, options = {}) {
  const response = await fetch(`${base}${endpoint}`, {
    ...options,
    headers: { ...headers, ...(options.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${endpoint}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}
async function pages(endpoint) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}
async function ensureLabel(name, color, description) {
  const response = await fetch(`${base}/labels`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name, color, description,
    }),
  });
  if (![201, 422].includes(response.status)) {
    throw new Error(`Cannot ensure ${name} label: ${response.status} ${await response.text()}`);
  }
}
const labels = issue => new Set(issue.labels.map(label => label.name));
const activeLabels = [...ISSUE_ACTIVE].filter(label => label !== PIPELINE_LABELS.architectReady);
const blockedLabels = [...ISSUE_TERMINAL, PIPELINE_LABELS.architectReady, PIPELINE_LABELS.epic];

function task(number) {
  const filename = path.join("tasks", `${number}.md`);
  if (!fs.existsSync(filename)) throw new Error(`missing ${filename}`);
  const contents = fs.readFileSync(filename, "utf8");
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("missing YAML front matter");
  const field = name => match[1].match(new RegExp(`^${name}:\\s*(.*?)\\s*$`, "m"))?.[1];
  if (Number(field("issue")) !== number) throw new Error("task issue number does not match filename");
  const priority = field("priority");
  if (!["P0", "P1", "P2"].includes(priority)) throw new Error("invalid priority");
  const raw = field("depends_on");
  if (!raw || !/^\[(?:\s*\d+\s*(?:,\s*\d+\s*)*)?\]$/.test(raw)) {
    throw new Error("depends_on must be an inline list of issue numbers");
  }
  const dependencies = raw.slice(1, -1).trim()
    ? raw.slice(1, -1).split(",").map(value => Number(value.trim()))
    : [];
  if (dependencies.includes(number)) throw new Error("task depends on itself");
  return { priority, dependencies };
}
async function snapshot(includeQueue = false) {
  const [issues, prs] = await Promise.all([
    pages("/issues?state=open"),
    pages("/pulls?state=open"),
  ]);
  const openIssues = issues.filter(issue => !issue.pull_request);
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
    else if (blockedLabels.some(label => labels(issue).has(label))) reason = "blocked by Pi failure label";
    let metadata;
    if (!reason) {
      try { metadata = task(issue.number); }
      catch (error) { reason = error.message; }
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
  let result = "";
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    const assistant = [...event.messages].reverse().find(message => message?.role === "assistant");
    const text = assistant?.content?.filter(part => part?.type === "text").map(part => part.text).join("");
    if (text?.trim()) result = text.trim();
  }
  return result;
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
  let toolResult = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "entry_appended" && event.entry?.type === "custom" &&
        event.entry?.customType === "dispatcher-result") {
      toolResult = event.entry.data;
    }
  }
  // Prefer the structured result from the submit_result tool
  // (pi-dispatcher-result-tool.mjs). The DISPATCH_RESULT text line is kept
  // only as a fallback while that tool is still a prototype.
  if (toolResult) return validateDispatch(toolResult);
  const text = finalText(jsonl);
  const lines = text.split(/\r?\n/).filter(line => line.startsWith("DISPATCH_RESULT: "));
  if (!lines.length) throw new Error("expected a DISPATCH_RESULT line");
  return validateDispatch(JSON.parse(lines.at(-1).slice("DISPATCH_RESULT: ".length)));
}
async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!["prepare", "apply"].includes(mode) || !file || !repo || !token) usage();
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
  for (const { issue: number, title } of initial.candidates) {
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
      await api(`/issues/${number}/labels`, {
        method: "POST", body: JSON.stringify({ labels: ["architect:ready"] }),
      });
      // GITHUB_TOKEN label events cannot trigger another Actions workflow.
      // Dispatch explicitly, and keep the new label if dispatch fails for a manual retry.
      await api("/actions/workflows/pi-architect.yml/dispatches", {
        method: "POST", body: JSON.stringify({ ref: "dev", inputs: { issue_number: String(number) } }),
      });
      await api(`/issues/${number}/labels/dispatcher%3Aready`, { method: "DELETE" });
      console.log(`Sent #${number} to Architect`);
      continue;
    }

    await api(`/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: ["pi:ready"] }),
    });
    try {
      await api("/actions/workflows/pi-issue-agent.yml/dispatches", {
        method: "POST",
        body: JSON.stringify({ ref: "dev", inputs: { issue_number: String(number) } }),
      });
    } catch (error) {
      try {
        await api(`/issues/${number}/labels/pi%3Aready`, { method: "DELETE" });
      } catch (rollbackError) {
        console.error(`Could not roll back pi:ready on #${number}: ${rollbackError}`);
      }
      throw error;
    }
    await api(`/issues/${number}/labels/dispatcher%3Aready`, { method: "DELETE" });
    console.log(`Dispatched #${number}`);
  }
  if (!selected.length) console.log("Dispatcher selected no issues");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

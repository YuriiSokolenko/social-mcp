#!/usr/bin/env node
// Dispatcher selection for the Pi automation queue.
//
// Everything that decides *which* issues may be dispatched — task metadata,
// candidate eligibility and order, and DISPATCH_RESULT validation — is pure or
// takes injected state, so it can be unit tested without GitHub credentials.
// The GitHub client below only fetches raw snapshot data and applies labels.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const READY_LABEL = "dispatcher:ready";
export const ACTIVE_LABELS = ["pi:ready", "pi:running", "pi:mr-created"];
export const BLOCKED_LABELS = ["pi:blocked", "pi:failed", "pi:needs-human", "pi:cancelled"];
export const PRIORITIES = ["P0", "P1", "P2"];
const PR_BRANCH = /^pi\/issue-([1-9]\d*)$/;

const labelNames = issue => (issue?.labels ?? [])
  .map(label => (typeof label === "string" ? label : label?.name))
  .filter(Boolean);
const hasAnyLabel = (issue, labels) => labels.some(label => labelNames(issue).includes(label));

/**
 * Parse the YAML front matter of a tasks/<issue-number>.md file.
 *
 * Throws for missing, malformed or contradictory metadata so callers can report
 * the reason instead of guessing a priority.
 *
 * @param {string} contents raw task file contents.
 * @param {number} number the GitHub issue number the file claims to describe.
 * @returns {{priority: string, dependencies: number[]}}
 */
export function parseTaskMetadata(contents, number) {
  const front = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) throw new Error("missing YAML front matter");
  const field = name => front[1].match(new RegExp(`^${name}:\\s*(.*?)\\s*$`, "m"))?.[1];
  if (Number(field("issue")) !== number) throw new Error("task issue number does not match filename");
  const priority = field("priority");
  if (!PRIORITIES.includes(priority)) throw new Error("invalid priority");
  const raw = field("depends_on");
  if (!raw || !/^\[(?:\s*\d+\s*(?:,\s*\d+\s*)*)?\]$/.test(raw)) {
    throw new Error("depends_on must be an inline list of issue numbers");
  }
  const list = raw.slice(1, -1);
  const dependencies = list.trim() ? list.split(",").map(value => Number(value.trim())) : [];
  if (dependencies.some(value => !Number.isSafeInteger(value))) throw new Error("depends_on must contain issue numbers");
  if (dependencies.includes(number)) throw new Error("task depends on itself");
  return { priority, dependencies };
}

/**
 * Read and parse tasks/<number>.md. Task files are data from `dev`, so a
 * missing or unreadable file becomes a skip reason rather than a crash.
 *
 * @param {number} number issue number.
 * @param {{taskDir?: string}} [options] directory holding the task files.
 * @returns {{priority: string, dependencies: number[]}}
 */
export function loadTaskMetadata(number, { taskDir = "tasks" } = {}) {
  const filename = path.join(taskDir, `${number}.md`);
  let contents;
  try {
    contents = fs.readFileSync(filename, "utf8");
  } catch (error) {
    throw new Error(`missing ${filename}${error.code === "ENOENT" ? "" : `: ${error.message}`}`);
  }
  return parseTaskMetadata(contents, number);
}

export const compareCandidates = (a, b) => a.priority.localeCompare(b.priority) || a.issue - b.issue;

/**
 * Apply the dispatcher candidate gate to a raw snapshot.
 *
 * Only an open issue carrying `dispatcher:ready`, with a valid matching
 * `tasks/<number>.md` and completed dependencies, and without an active or
 * blocked Pi label, or an open implementation PR, may be dispatched.
 *
 * @param {unknown[]} issues open issues from the snapshot.
 * @param {unknown[]} openPrs open pull requests from the snapshot.
 * @param {object} options
 * @param {string} options.repo `owner/name` that owns implementation branches.
 * @param {string} [options.taskDir] directory holding task files.
 * @param {(number: number, dependencies: number[]) => unknown} options.completedDependencies
 *   resolves the completed subset of a candidate's dependency issues.
 * @returns {Promise<{active: number[], candidates: {issue:number,priority:string,title:string}[], skipped: {issue:number,reason:string}[]}>}
 */
export async function selectCandidates(issues, openPrs, { repo, taskDir = "tasks", completedDependencies = () => new Set() } = {}) {
  const openPrIssues = new Set();
  for (const pr of openPrs) {
    if (pr.head?.repo?.full_name !== repo || pr.base?.ref !== "dev") continue;
    const match = PR_BRANCH.exec(pr.head?.ref ?? "");
    if (match) openPrIssues.add(Number(match[1]));
  }
  const active = new Set(openPrIssues);
  for (const issue of issues) if (hasAnyLabel(issue, ACTIVE_LABELS)) active.add(issue.number);

  const skipped = [];
  const candidates = [];
  for (const issue of issues.filter(item => hasAnyLabel(item, [READY_LABEL]))) {
    if (active.has(issue.number)) {
      skipped.push({ issue: issue.number, reason: "already active" });
      continue;
    }
    if (hasAnyLabel(issue, BLOCKED_LABELS)) {
      skipped.push({ issue: issue.number, reason: "blocked by Pi failure label" });
      continue;
    }
    let metadata;
    try {
      metadata = loadTaskMetadata(issue.number, { taskDir });
    } catch (error) {
      skipped.push({ issue: issue.number, reason: error.message });
      continue;
    }
    const completed = await completedDependencies(issue.number, metadata.dependencies);
    const isCompleted = number => (completed instanceof Set ? completed : new Set(completed)).has(number);
    const pending = metadata.dependencies.filter(number => !isCompleted(number));
    if (pending.length) {
      skipped.push({ issue: issue.number, reason: `dependency #${pending[0]} is not completed` });
      continue;
    }
    candidates.push({ issue: issue.number, priority: metadata.priority, title: issue.title });
  }
  candidates.sort(compareCandidates);
  return { active: [...active].sort((a, b) => a - b), candidates, skipped };
}

const rejection = (issue, code, reason) => ({ issue, code, reason });

/**
 * Re-check a dispatcher result against a freshly rebuilt snapshot.
 *
 * A queued dispatcher must never trust its trigger event, so only issues that
 * are still eligible candidates, selected in priority order and covering the
 * whole candidate list, may be applied. An issue an earlier dispatcher already
 * labelled is a successful no-op, not a failure.
 *
 * @param {number[]} selected issue numbers from DISPATCH_RESULT, in dispatcher order.
 * @param {{active: number[], candidates: {issue:number}[]}} snapshot a freshly read queue snapshot.
 * @returns {{accepted: number[], noOps: number[], rejected: {issue:number,code:string,reason:string}[]}}
 */
export function validateSelection(selected, snapshot) {
  const eligible = snapshot.candidates.map(candidate => candidate.issue);
  const rejected = [];
  const noOps = [];
  const chosen = [];
  const seen = new Set();

  for (const number of selected) {
    if (!Number.isSafeInteger(number)) {
      rejected.push(rejection(number, "invalid", "not a valid issue number"));
      continue;
    }
    if (seen.has(number)) {
      rejected.push(rejection(number, "duplicate", "duplicate issue"));
      continue;
    }
    seen.add(number);
    if (eligible.includes(number)) chosen.push(number);
    else if (snapshot.active.includes(number)) noOps.push(number);
    else rejected.push(rejection(number, "not-eligible", "no longer an eligible candidate"));
  }

  // The dispatcher must select every currently eligible issue in priority order.
  const misplaced = chosen.filter((number, index) => number !== eligible[index]);
  if (misplaced.length) {
    for (const number of misplaced) {
      rejected.push(rejection(number, "out-of-order", "out of priority order for the current candidate list"));
    }
    for (const number of eligible) {
      if (!seen.has(number)) rejected.push(rejection(number, "missing", "eligible issue is missing from the dispatcher result"));
    }
    return { accepted: [], noOps, rejected };
  }
  return { accepted: chosen, noOps, rejected };
}

/**
 * Validate the dispatcher's final `DISPATCH_RESULT:` line.
 *
 * @param {string} jsonl raw Pi job log.
 * @returns {number[]} selected issue numbers in dispatcher order.
 */
export function parseDispatchResult(jsonl) {
  const lines = finalText(jsonl).split(/\r?\n/).filter(line => line.startsWith("DISPATCH_RESULT: "));
  if (lines.length !== 1) throw new Error("expected exactly one DISPATCH_RESULT line");
  let result;
  try {
    result = JSON.parse(lines[0].slice("DISPATCH_RESULT: ".length));
  } catch (error) {
    throw new Error(`invalid DISPATCH_RESULT json: ${error.message}`);
  }
  if (!Array.isArray(result.issues) || !result.issues.every(Number.isSafeInteger)) {
    throw new Error("invalid dispatcher issue list");
  }
  if (new Set(result.issues).size !== result.issues.length) throw new Error("duplicate issue");
  return result.issues;
}

/**
 * Decide whether an accepted issue may still be labelled, using state re-read
 * immediately before the write.
 *
 * @param {number} number issue number.
 * @param {{active: number[], candidates: {issue:number}[]}} snapshot freshly read queue snapshot.
 * @returns {{action: "dispatch"|"skip", reason?: string}}
 */
export function classifyDispatch(number, snapshot) {
  if (snapshot.active.includes(number)) {
    return { action: "skip", reason: "already assigned by an earlier dispatcher" };
  }
  if (!snapshot.candidates.some(candidate => candidate.issue === number)) {
    return { action: "skip", reason: "no longer an eligible candidate" };
  }
  if (snapshot.candidates[0]?.issue !== number) {
    return { action: "skip", reason: "no longer the next eligible issue" };
  }
  return { action: "dispatch" };
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

/**
 * GitHub client for the dispatcher. It holds no selection policy: it reads raw
 * snapshot data and applies the labels the pure layer asks for.
 */
export class GitHub {
  constructor({ repo, token, fetchImpl = globalThis.fetch }) {
    if (!repo || !token) throw new Error("repo and token are required");
    Object.assign(this, { repo, token, fetchImpl, base: `https://api.github.com/repos/${repo}` });
  }

  async request(endpoint, options = {}) {
    const response = await this.fetchImpl(`${this.base}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub ${response.status} ${endpoint}: ${await response.text()}`);
    if (response.status === 204) return null;
    return response.json();
  }

  async pages(endpoint) {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  async ensureReadyLabel() {
    const response = await this.fetchImpl(`${this.base}/labels`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: READY_LABEL, color: "d4c5f9", description: "Eligible for Pi dispatcher selection" }),
    });
    if (![201, 422].includes(response.status)) {
      throw new Error(`Cannot ensure ${READY_LABEL} label: ${response.status} ${await response.text()}`);
    }
  }

  /** Read the raw queue state and apply the candidate gate to it. */
  async snapshot() {
    const [issues, prs] = await Promise.all([this.pages("/issues?state=open"), this.pages("/pulls?state=open")]);
    const openIssues = issues.filter(issue => !issue.pull_request);
    // An open issue can only gain dependencies, so a dependency that is
    // completed now cannot become incomplete while this read-only pass runs.
    const completedDependencies = async (_number, dependencies) => {
      const completed = new Set();
      for (const dependency of dependencies) {
        const state = await this.request(`/issues/${dependency}`);
        if (!state.pull_request && state.state === "closed" && state.state_reason === "completed") completed.add(dependency);
      }
      return completed;
    };
    return selectCandidates(openIssues, prs, { repo: this.repo, completedDependencies });
  }

  async addLabel(number, label) {
    return this.request(`/issues/${number}/labels`, { method: "POST", body: JSON.stringify({ labels: [label] }) });
  }

  async removeLabel(number, label) {
    return this.request(`/issues/${number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
  }

  async dispatch(number) {
    return this.request("/dispatches", {
      method: "POST",
      body: JSON.stringify({ event_type: "pi_dispatch_issue", client_payload: { issue_number: number } }),
    });
  }
}

/**
 * Prepare the dispatcher context for the model: raw active/candidate/skipped state.
 *
 * @param {GitHub} client
 * @returns {Promise<{active: number[], candidates: unknown[], skipped: unknown[]}>}
 */
export async function runPrepare(client) {
  await client.ensureReadyLabel();
  return client.snapshot();
}

/**
 * Validate a dispatcher result and apply it, re-reading GitHub state before
 * every label write.
 *
 * @param {GitHub} client
 * @param {string} jsonl raw Pi job log.
 * @param {(message: string) => void} [log]
 * @returns {Promise<{dispatched: number[], noOps: number[], rejected: {issue:number,code:string,reason:string}[]}>}
 */
export async function runApply(client, jsonl, log = message => console.log(message)) {
  const { accepted, noOps, rejected } = validateSelection(parseDispatchResult(jsonl), await client.snapshot());
  for (const item of rejected) log(`Rejected #${item.issue}: ${item.reason}`);
  for (const number of noOps) log(`Skipped #${number}: already assigned by an earlier dispatcher`);
  // Never apply a partially invalid selection: an unverified issue must keep
  // its dispatcher:ready label rather than be replaced by a silently
  // substituted candidate. Report and let a human, or the next dispatcher run,
  // rebuild the queue.
  if (rejected.length) return { dispatched: [], noOps, rejected };

  const dispatched = [];
  for (const number of [...noOps, ...accepted]) {
    // The concurrency group serializes dispatcher jobs, but queued jobs can
    // start with stale trigger events. Always rebuild state after acquiring the
    // runner and treat GitHub state, not the triggering event, as the source of
    // truth. A previous serialized dispatcher may already have assigned this
    // issue: that is a successful no-op and must never emit a duplicate
    // repository_dispatch event.
    const verdict = classifyDispatch(number, await client.snapshot());
    if (verdict.action === "skip") {
      log(`Skipped #${number}: ${verdict.reason}`);
      continue;
    }

    await client.addLabel(number, "pi:ready");
    try {
      await client.dispatch(number);
    } catch (error) {
      try {
        await client.removeLabel(number, "pi:ready");
      } catch (rollbackError) {
        console.error(`Could not roll back pi:ready on #${number}: ${rollbackError}`);
      }
      throw error;
    }
    await client.removeLabel(number, READY_LABEL);
    log(`Dispatched #${number}`);
    dispatched.push(number);
  }
  if (!dispatched.length) log("Dispatcher selected no issues");
  return { dispatched, noOps, rejected };
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!["prepare", "apply"].includes(mode) || !file) {
    throw new Error("usage: pi-dispatcher.mjs prepare <context.json> | apply <pi-jsonl>");
  }
  const client = new GitHub({ repo: process.env.REPO, token: process.env.GH_TOKEN });

  if (mode === "prepare") {
    const data = await runPrepare(client);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log(`Dispatcher: ${data.active.length} active, ${data.candidates.length} ready candidates`);
    for (const item of data.skipped) console.log(`Skipped #${item.issue}: ${item.reason}`);
    return;
  }

  const { rejected } = await runApply(client, fs.readFileSync(file, "utf8"));
  // Every rejected entry has already been logged with its reason. A stale or
  // partial selection is a real problem, never a silent fallback to dispatching
  // a different issue.
  if (rejected.length) {
    console.error("Dispatcher result did not match the current queue state");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

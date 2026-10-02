#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { githubClient } from "./pi-common/github-api.mjs";
import { replaceIssueState } from "./pi-common/github-state.mjs";
import { PIPELINE_LABELS, validateIssueTransition } from "./pi-common/state-machine.mjs";
import { acceptanceCriteria, taskMetadata } from "./pi-common/task-metadata.mjs";
import { readPiJsonl } from "./pi-common/result-jsonl.mjs";

const { api: request, pages, ensureLabel, repo, comment: postIssueComment } = githubClient();
const api = (endpoint, options = {}) =>
  request(endpoint, options.method ?? "GET", options.body ? JSON.parse(options.body) : undefined);
function usage() {
  throw new Error("usage: pi-triage.mjs prepare <context.json> | apply <pi-jsonl>");
}

const labelsOf = issue => new Set(issue.labels.map(label => label.name));
async function transitionIssue(number, action) {
  const expected = await api(`/issues/${number}`);
  const target = validateIssueTransition(expected, action);
  await replaceIssueState({
    number,
    expected,
    target,
    context: "Triage",
    load: issue => api(`/issues/${issue}`),
    patch: (issue, labels) => api(`/issues/${issue}`, {
      method: "PATCH",
      body: JSON.stringify({ labels }),
    }),
  });
}


// Issues already in one of these states are owned by another stage of the
// pipeline; triage never re-classifies them. `triage:ready` is intentionally
// excluded because it is the explicit ownership label for this stage. `pi:blocked` is a durable stop.
// `pi:needs-human` is handled separately below. Triage only reconsiders it
// when its own marker proves that Triage created the state and the body changed;
// a manually applied `pi:needs-human` label is durable until a human retries it.
const pipelineLabels = [
  PIPELINE_LABELS.queued, PIPELINE_LABELS.ready, PIPELINE_LABELS.running, PIPELINE_LABELS.pr,
  PIPELINE_LABELS.blocked, PIPELINE_LABELS.architectReady, PIPELINE_LABELS.epic,
];

function hash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}
function markerFor(body) {
  return `<!-- pi-triage:hash:${hash(body ?? "")} -->`;
}
function hashFor(body) {
  return hash(body ?? "");
}

function issueMetadata(issue) {
  return taskMetadata(issue, { required: false });
}

function lastTriageHash(comments) {
  for (const comment of [...comments].reverse()) {
    const match = /<!-- pi-triage:hash:([0-9a-f]{16}) -->/.exec(comment.body ?? "");
    if (match) return match[1];
  }
  return null;
}

async function candidates() {
  const issues = (await pages("/issues?state=open")).filter(issue => !issue.pull_request);
  const openByNumber = new Map(issues.map(issue => [issue.number, issue]));
  const dependencyState = async number => {
    const open = openByNumber.get(number);
    if (open) return { issue: number, state: "open", title: open.title };
    try {
      const dependency = await api(`/issues/${number}`);
      return {
        issue: number,
        state: dependency.state,
        title: dependency.title,
        pull_request: !!dependency.pull_request,
      };
    } catch (error) {
      return { issue: number, state: "unknown", error: String(error?.message ?? error) };
    }
  };
  const result = [];
  for (const issue of issues) {
    const owned = labelsOf(issue);
    if (pipelineLabels.some(label => owned.has(label))) continue;
    const needsHuman = owned.has(PIPELINE_LABELS.needsHuman);
    const triageRequested = owned.has(PIPELINE_LABELS.triageReady);
    if (!triageRequested && !needsHuman) continue;
    const task = issueMetadata(issue);
    let comments = [];
    if (needsHuman) {
      comments = await pages(`/issues/${issue.number}/comments`);
      const previousHash = lastTriageHash(comments);
      const currentHash = hashFor(issue.body);
      if (previousHash === null) continue; // manual needs-human is durable
      if (previousHash === currentHash) continue; // nothing changed since last review
    }
    const dependencies = task.valid
      ? await Promise.all(task.dependencies.map(dependencyState))
      : [];
    result.push({
      issue: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      labels: [...owned],
      reconsidering: needsHuman,
      recent_comments: comments
        .filter(comment => !/<!-- pi-triage:hash:/.test(comment.body ?? ""))
        .slice(-15)
        .map(comment => ({ author: comment.user?.login ?? "unknown", body: comment.body ?? "" })),
      task,
      acceptance_criteria: acceptanceCriteria(issue.body ?? ""),
      dependency_states: dependencies,
    });
  }
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

export function validateTriage(result) {
  const isIntArray = value => Array.isArray(value) && value.every(Number.isSafeInteger);
  if (!isIntArray(result.ready)) throw new Error("invalid ready list");
  if (!Array.isArray(result.needs_human) || !result.needs_human.every(item =>
    Number.isSafeInteger(item?.issue) && typeof item.comment === "string" &&
    item.comment.trim().length >= 10 && item.comment.length <= 2000
  )) throw new Error("invalid needs_human list");
  if (!Array.isArray(result.skipped) || !result.skipped.every(item =>
    Number.isSafeInteger(item?.issue) && typeof item.reason === "string" && item.reason.trim().length > 0
  )) throw new Error("invalid skipped list");

  const classified = [
    ...result.ready,
    ...result.needs_human.map(item => item.issue),
    ...result.skipped.map(item => item.issue),
  ];
  if (new Set(classified).size !== classified.length) throw new Error("duplicate issue classification");
  return result;
}

export function triageFromJsonl(jsonl) {
  const { customResult } = readPiJsonl(jsonl, { customType: "triage-result" });
  if (!customResult) throw new Error("expected submit_result tool output");
  return validateTriage(customResult);
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!["prepare", "apply"].includes(mode) || !file) usage();
  if (mode === "prepare") {
    await ensureLabel(PIPELINE_LABELS.triageReady, "c5def5", "Explicitly queued for Pi triage");
    await ensureLabel(PIPELINE_LABELS.queued, "d4c5f9", "Eligible for Pi dispatcher selection");
    await ensureLabel(PIPELINE_LABELS.needsHuman, "fbca04", "Pi finished without a usable repository change");
    const list = await candidates();
    const batchSize = Number(process.env.PI_TRIAGE_BATCH_SIZE ?? 8);
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("PI_TRIAGE_BATCH_SIZE must be a positive integer");
    const batch = list.slice(0, batchSize);
    fs.writeFileSync(file, JSON.stringify({ candidates: batch }, null, 2) + "\n");
    console.log(`Triage: ${batch.length} candidate issue(s)${list.length > batch.length ? ` of ${list.length} pending` : ""}`);
    for (const item of batch) {
      console.log(`  #${item.issue}${item.reconsidering ? " (re-check after change)" : ""}`);
    }
    return;
  }

  const result = triageFromJsonl(fs.readFileSync(file, "utf8"));
  const classified = [
    ...result.ready,
    ...result.needs_human.map(item => item.issue),
    ...result.skipped.map(item => item.issue),
  ];

  // Recompute eligibility now, at apply time, rather than trusting the
  // prepare-time snapshot: it is the source of truth for what must be
  // classified.
  const batchSize = Number(process.env.PI_TRIAGE_BATCH_SIZE ?? 8);
  const current = (await candidates()).slice(0, batchSize);
  const currentNumbers = current.map(item => item.issue).sort((a, b) => a - b);
  const classifiedNumbers = [...classified].sort((a, b) => a - b);
  if (JSON.stringify(currentNumbers) !== JSON.stringify(classifiedNumbers)) {
    throw new Error("classify every current candidate exactly once");
  }

  for (const number of result.ready) {
    const issue = await api(`/issues/${number}`);
    const owned = labelsOf(issue);
    if (issue.state !== "open" || pipelineLabels.some(label => owned.has(label))) {
      console.log(`Skipped #${number}: no longer an eligible candidate`);
      continue;
    }
    const ac = acceptanceCriteria(issue.body ?? "");
    if (!ac.valid) throw new Error(`#${number} cannot be ready: ${ac.error}`);
    await transitionIssue(number, "queued");
    console.log(`Marked #${number} ${PIPELINE_LABELS.queued}`);
  }

  for (const { issue: number, comment } of result.needs_human) {
    const issue = await api(`/issues/${number}`);
    const owned = labelsOf(issue);
    if (issue.state !== "open" || pipelineLabels.some(label => owned.has(label))) {
      console.log(`Skipped #${number}: no longer an eligible candidate`);
      continue;
    }
    const marker = markerFor(issue.body);
    if (!owned.has(PIPELINE_LABELS.needsHuman)) await transitionIssue(number, "needs-human");
    await postIssueComment(number, `Pi Triage: needs a person before this can be dispatched.\n\n${comment}\n\n${marker}`);
    console.log(`Flagged #${number} ${PIPELINE_LABELS.needsHuman}`);
  }

  if (result.skipped.length) {
    console.log(`Skipped: [${result.skipped.map(item => item.issue).join(", ")}]`);
  }
  if (!classified.length) console.log("Triage found no candidate issues");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
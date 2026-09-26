#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
function usage() {
  throw new Error("usage: pi-triage.mjs prepare <context.json> | apply <pi-jsonl>");
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
    body: JSON.stringify({ name, color, description }),
  });
  if (![201, 422].includes(response.status)) {
    throw new Error(`Cannot ensure ${name} label: ${response.status} ${await response.text()}`);
  }
}

const labelsOf = issue => new Set(issue.labels.map(label => label.name));

// Issues already in one of these states are owned by another stage of the
// pipeline; triage never re-classifies them. `pi:needs-human` is handled
// separately below, since triage is exactly what re-reviews those.
const pipelineLabels = [
  "dispatcher:ready", "pi:ready", "pi:running", "pi:mr-created", "pi:blocked",
  "pi:failed", "pi:cancelled", "architect:ready", "architect:epic",
];

function hash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}
function markerFor(body, taskText) {
  return `<!-- pi-triage:hash:${hash(`${body ?? ""}\u0000${taskText ?? ""}`)} -->`;
}
function hashFor(body, taskText) {
  return hash(`${body ?? ""}\u0000${taskText ?? ""}`);
}

function readTask(number) {
  const filename = path.join("tasks", `${number}.md`);
  if (!fs.existsSync(filename)) return { exists: false };
  const contents = fs.readFileSync(filename, "utf8");
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { exists: true, text: contents, valid: false, errors: ["missing YAML front matter"] };
  const field = name => match[1].match(new RegExp(`^${name}:\\s*(.*?)\\s*$`, "m"))?.[1];
  const issueField = field("issue");
  const priority = field("priority");
  const raw = field("depends_on");
  const errors = [];
  if (Number(issueField) !== number) errors.push("task issue number does not match filename");
  if (!["P0", "P1", "P2"].includes(priority)) errors.push("invalid or missing priority");
  const dependsOnValid = !!raw && /^\[(?:\s*\d+\s*(?:,\s*\d+\s*)*)?\]$/.test(raw);
  if (!dependsOnValid) errors.push("depends_on must be an inline list of issue numbers");
  const dependencies = dependsOnValid && raw.slice(1, -1).trim()
    ? raw.slice(1, -1).split(",").map(value => Number(value.trim()))
    : [];
  if (dependsOnValid && dependencies.includes(number)) errors.push("task depends on itself");
  return {
    exists: true, text: contents, valid: errors.length === 0, errors,
    priority: priority ?? null, dependencies,
  };
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
    const needsHuman = owned.has("pi:needs-human");
    const task = readTask(issue.number);
    let comments = [];
    if (needsHuman) {
      comments = await pages(`/issues/${issue.number}/comments`);
      const previousHash = lastTriageHash(comments);
      const currentHash = hashFor(issue.body, task.exists ? task.text : "");
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
  let toolResult = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "entry_appended" && event.entry?.type === "custom" &&
        event.entry?.customType === "triage-result") {
      toolResult = event.entry.data;
    }
  }
  // Prefer the structured result from the submit_result tool
  // (pi-triage-result-tool.mjs). The TRIAGE_RESULT text line is kept only as
  // a fallback while that tool is still a prototype.
  if (toolResult) return validateTriage(toolResult);
  const text = finalText(jsonl);
  const lines = text.split(/\r?\n/).filter(line => line.startsWith("TRIAGE_RESULT: "));
  if (!lines.length) throw new Error("expected a TRIAGE_RESULT line");
  return validateTriage(JSON.parse(lines.at(-1).slice("TRIAGE_RESULT: ".length)));
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!["prepare", "apply"].includes(mode) || !file || !repo || !token) usage();
  if (mode === "prepare") {
    await ensureLabel("dispatcher:ready", "d4c5f9", "Eligible for Pi dispatcher selection");
    await ensureLabel("pi:needs-human", "fbca04", "Pi finished without a usable repository change");
    const list = await candidates();
    fs.writeFileSync(file, JSON.stringify({ candidates: list }, null, 2) + "\n");
    console.log(`Triage: ${list.length} candidate issue(s)`);
    for (const item of list) {
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
  const current = await candidates();
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
    await api(`/issues/${number}/labels`, {
      method: "POST", body: JSON.stringify({ labels: ["dispatcher:ready"] }),
    });
    if (owned.has("pi:needs-human")) {
      await api(`/issues/${number}/labels/pi%3Aneeds-human`, { method: "DELETE" });
    }
    console.log(`Marked #${number} dispatcher:ready`);
  }

  for (const { issue: number, comment } of result.needs_human) {
    const issue = await api(`/issues/${number}`);
    const owned = labelsOf(issue);
    if (issue.state !== "open" || pipelineLabels.some(label => owned.has(label))) {
      console.log(`Skipped #${number}: no longer an eligible candidate`);
      continue;
    }
    const task = readTask(number);
    const marker = markerFor(issue.body, task.exists ? task.text : "");
    if (!owned.has("pi:needs-human")) {
      await api(`/issues/${number}/labels`, {
        method: "POST", body: JSON.stringify({ labels: ["pi:needs-human"] }),
      });
    }
    await api(`/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: `Pi Triage: needs a person before this can be dispatched.\n\n${comment}\n\n${marker}`,
      }),
    });
    console.log(`Flagged #${number} pi:needs-human`);
  }

  for (const { issue: number, reason } of result.skipped) {
    console.log(`Skipped #${number}: ${reason}`);
  }
  if (!classified.length) console.log("Triage found no candidate issues");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

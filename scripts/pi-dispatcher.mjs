#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [mode, file] = process.argv.slice(2);
const repo = process.env.REPO;
const token = process.env.GH_TOKEN;
if (!["prepare", "apply"].includes(mode) || !file || !repo || !token) {
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
async function ensureReadyLabel() {
  const response = await fetch(`${base}/labels`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "dispatcher:ready",
      color: "d4c5f9",
      description: "Eligible for Pi dispatcher selection",
    }),
  });
  if (![201, 422].includes(response.status)) {
    throw new Error(`Cannot ensure dispatcher:ready label: ${response.status} ${await response.text()}`);
  }
}
const labels = issue => new Set(issue.labels.map(label => label.name));
const activeLabels = ["pi:ready", "pi:running", "pi:mr-created"];
const blockedLabels = ["pi:failed", "pi:needs-human", "pi:cancelled"];

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
async function snapshot() {
  const [issues, prs] = await Promise.all([
    pages("/issues?state=open"),
    pages("/pulls?state=open"),
  ]);
  const openIssues = issues.filter(issue => !issue.pull_request);
  const openPrIssues = new Set();
  for (const pr of prs) {
    if (pr.head.repo?.full_name !== repo || pr.base.ref !== "main") continue;
    const match = pr.head.ref.match(/^pi\/issue-(\d+)$/);
    if (match) openPrIssues.add(Number(match[1]));
  }
  const active = new Set(openPrIssues);
  for (const issue of openIssues) {
    if (activeLabels.some(label => labels(issue).has(label))) active.add(issue.number);
  }
  const skipped = [];
  const candidates = [];
  for (const issue of openIssues.filter(item => labels(item).has("dispatcher:ready"))) {
    let reason;
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
    else candidates.push({ issue: issue.number, priority: metadata.priority, title: issue.title });
  }
  candidates.sort((a, b) => a.priority.localeCompare(b.priority) || a.issue - b.issue);
  return { active: [...active].sort((a, b) => a - b), candidates, skipped };
}
function finalText(jsonl) {
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
async function main() {
  if (mode === "prepare") {
    await ensureReadyLabel();
    const data = await snapshot();
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log(`Dispatcher: ${data.active.length} active, ${data.candidates.length} ready candidates`);
    for (const item of data.skipped) console.log(`Skipped #${item.issue}: ${item.reason}`);
    return;
  }
  const text = finalText(fs.readFileSync(file, "utf8"));
  const lines = text.split(/\r?\n/).filter(line => line.startsWith("DISPATCH_RESULT: "));
  if (lines.length !== 1) throw new Error("expected exactly one DISPATCH_RESULT line");
  const result = JSON.parse(lines[0].slice("DISPATCH_RESULT: ".length));
  if (!Array.isArray(result.issues) || !result.issues.every(Number.isSafeInteger)) {
    throw new Error("invalid dispatcher issue list");
  }
  const selected = result.issues;
  if (new Set(selected).size !== selected.length) throw new Error("duplicate issue");
  const initial = await snapshot();
  if (selected.length !== initial.candidates.length ||
      selected.some((number, index) => number !== initial.candidates[index]?.issue)) {
    throw new Error("dispatcher result must contain all eligible issues in priority order");
  }
  for (const number of selected) {
    const state = await snapshot();
    if (number !== state.candidates[0]?.issue) throw new Error(`#${number} is not the next eligible issue`);
    await api(`/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: ["pi:ready"] }),
    });
    try {
      await api("/dispatches", {
        method: "POST",
        body: JSON.stringify({ event_type: "pi_dispatch_issue", client_payload: { issue_number: number } }),
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
main().catch(error => { console.error(error); process.exitCode = 1; });

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readQueueContext } from './pi-queue-context.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const base = `https://api.github.com/repos/${repo}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(endpoint, method = 'GET', body) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`${method} ${endpoint}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export function parentOf(body) {
  const match = /<!-- architect-parent:(\d+); architect-key:([a-z][a-z0-9-]*) -->/.exec(body ?? '');
  return match ? Number(match[1]) : null;
}

export function childNumbers(body) {
  const match = /<!-- architect-children:([1-9]\d*(?:,[1-9]\d*)*) -->/.exec(body ?? '');
  return match ? match[1].split(',').map(Number) : [];
}

export function planFromJsonl(jsonl, parent) {
  let final = '';
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'agent_end' || !Array.isArray(event.messages)) continue;
    const assistant = [...event.messages].reverse().find(message => message?.role === 'assistant');
    final = assistant?.content?.filter(part => part?.type === 'text').map(part => part.text).join('') ?? final;
  }
  const lines = final.split(/\r?\n/).filter(line => line.startsWith('ARCHITECT_RESULT: '));
  if (lines.length !== 1) throw new Error('Expected exactly one ARCHITECT_RESULT line');
  return validatePlan(JSON.parse(lines[0].slice('ARCHITECT_RESULT: '.length)), parent);
}

export function validatePlan(plan, parent) {
  if (plan?.parent_issue !== parent || !Array.isArray(plan.steps) ||
      plan.steps.length < 2 || plan.steps.length > 6) {
    throw new Error('Plan must split the selected issue into 2-6 steps');
  }
  const seen = new Map();
  let stage = 0;
  for (const step of plan.steps) {
    if (!step || !/^[a-z][a-z0-9-]{0,31}$/.test(step.key ?? '') || seen.has(step.key) ||
        !['contract', 'test', 'implementation'].includes(step.kind) ||
        !['P0', 'P1', 'P2'].includes(step.priority) ||
        typeof step.title !== 'string' || step.title.length < 12 || step.title.length > 110 ||
        typeof step.body !== 'string' || step.body.length < 120 || step.body.length > 5000 ||
        !Array.isArray(step.depends_on) || !step.depends_on.every(key => seen.has(key)) ||
        new Set(step.depends_on).size !== step.depends_on.length) {
      throw new Error('Invalid step metadata, duplicate key, or forward dependency');
    }
    const nextStage = { contract: 0, test: 1, implementation: 2 }[step.kind];
    if (nextStage < stage) throw new Error('Contract, test and implementation stages must be ordered');
    stage = nextStage;
    if (step.kind === 'test' && seen.size && [...seen.values()].some(x => x.kind === 'contract') &&
        !step.depends_on.some(key => seen.get(key).kind === 'contract')) {
      throw new Error('A separate test task must depend on the contract task');
    }
    if (step.kind === 'implementation' && [...seen.values()].some(x => x.kind === 'test') &&
        !step.depends_on.some(key => seen.get(key).kind === 'test')) {
      throw new Error('Implementation must depend on the separate test task');
    }
    seen.set(step.key, step);
  }
  return plan;
}

function taskMetadata(number) {
  const filename = path.join('tasks', `${number}.md`);
  if (!fs.existsSync(filename)) return { priority: 'P1', dependencies: [] };
  const source = fs.readFileSync(filename, 'utf8');
  const priority = /^priority:\s*(P[012])\s*$/m.exec(source)?.[1];
  const raw = /^depends_on:\s*\[([^\]]*)\]\s*$/m.exec(source)?.[1];
  if (!priority || raw === undefined || (raw.trim() && !/^\d+(?:\s*,\s*\d+)*$/.test(raw.trim()))) {
    throw new Error(`Invalid metadata in ${filename}`);
  }
  return {
    priority,
    dependencies: raw.trim() ? raw.split(',').map(value => Number(value.trim())) : [],
  };
}

async function allIssues() {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/issues?state=all&per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items.filter(issue => !issue.pull_request);
  }
}

async function ensureLabel(name, color, description) {
  const current = await api(`/labels/${encodeURIComponent(name)}`);
  if (!current) await api('/labels', 'POST', { name, color, description });
}

async function ensureTask(number, title, priority, dependencies, body) {
  const filename = `tasks/${number}.md`;
  const content = `---\nissue: ${number}\npriority: ${priority}\ndepends_on: [${dependencies.join(', ')}]\n---\n\n# ${title}\n\n## Scope and acceptance\n${body}\n`;
  const existing = await api(`/contents/${filename}?ref=dev`);
  if (existing) {
    if (Buffer.from(existing.content.replace(/\s/g, ''), 'base64').toString('utf8') !== content) {
      throw new Error(`${filename} already exists with different content`);
    }
    return;
  }
  await api(`/contents/${filename}`, 'PUT', {
    message: `Add architect task for issue #${number}`,
    content: Buffer.from(content).toString('base64'),
    branch: 'dev',
  });
}

async function prepare(issue, filename) {
  const parent = await api(`/issues/${issue}`);
  const labels = new Set(parent?.labels?.map(label => label.name));
  if (parent?.state === 'open' && !labels.has('architect:ready') &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    await ensureLabel('architect:ready', 'c5def5', 'Large issue approved for Pi Architect');
    await api(`/issues/${issue}/labels`, 'POST', { labels: ['architect:ready'] });
    labels.add('architect:ready');
  }
  if (!parent || parent.state !== 'open' || !labels.has('architect:ready') ||
      ['pi:running', 'pi:ready', 'pi:mr-created', 'pi:failed', 'pi:needs-human'].some(x => labels.has(x))) {
    throw new Error('Parent must be an open, inactive issue labeled architect:ready');
  }
  if (labels.has('dispatcher:ready')) {
    await api(`/issues/${issue}/labels/dispatcher%3Aready`, 'DELETE');
  }
  const openIssues = (await allIssues()).filter(x => x.state === 'open');
  const known = openIssues
    .map(x => ({ number: x.number, title: x.title, labels: x.labels.map(y => y.name) }));
  const prs = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/pulls?state=open&base=dev&per_page=100&page=${page}`);
    prs.push(...batch);
    if (batch.length < 100) break;
  }
  const queue = await readQueueContext(endpoint => api(endpoint), repo, openIssues, prs);
  fs.writeFileSync(filename, JSON.stringify({
    number: issue, title: parent.title, body: parent.body,
    metadata: taskMetadata(issue), open_issues: known, queue,
  }, null, 2));
}

async function publish(issue, jsonl) {
  const parent = await api(`/issues/${issue}`);
  if (parent?.state !== 'open' || !parent.labels.some(label => label.name === 'architect:ready')) {
    throw new Error('Parent changed while Architect was planning');
  }
  const plan = planFromJsonl(fs.readFileSync(jsonl, 'utf8'), issue);
  const inherited = taskMetadata(issue).dependencies;
  const existing = await allIssues();
  const created = new Map();
  for (const step of plan.steps) {
    const marker = `<!-- architect-parent:${issue}; architect-key:${step.key} -->`;
    const body = `Part of #${issue}.\n\n${step.body}\n\n${marker}`;
    const matches = existing.filter(item => item.body?.includes(marker));
    if (matches.length > 1) throw new Error(`Duplicate issues for ${marker}`);
    const task = matches[0] ?? await api('/issues', 'POST', { title: step.title, body });
    if (!matches.length) existing.push(task);
    if (task.state !== 'open' || task.title !== step.title || task.body !== body) {
      throw new Error(`Existing issue #${task.number} differs from Architect plan`);
    }
    const dependencies = [...new Set([
      ...inherited, ...step.depends_on.map(key => created.get(key)),
    ])];
    await ensureTask(task.number, step.title, step.priority, dependencies, step.body);
    created.set(step.key, task.number);
    console.log(`${step.key}: #${task.number} after [${dependencies.join(', ')}]`);
  }
  const children = [...created.values()];
  const marker = `<!-- architect-children:${children.join(',')} -->`;
  if (childNumbers(parent.body).length && !parent.body.includes(marker)) {
    throw new Error('Parent already has a different decomposition');
  }
  if (!parent.body.includes(marker)) {
    await api(`/issues/${issue}`, 'PATCH', { body: `${parent.body ?? ''}\n\n${marker}` });
  }
  await ensureLabel('architect:epic', '7057ff', 'Parent issue split into linked work items');
  await ensureLabel('dispatcher:ready', 'd4c5f9', 'Eligible for Pi dispatcher selection');
  await api(`/issues/${issue}/labels`, 'POST', { labels: ['architect:epic'] });
  for (const number of children) {
    await api(`/issues/${number}/labels`, 'POST', { labels: ['dispatcher:ready'] });
  }
  await api(`/issues/${issue}/labels/architect%3Aready`, 'DELETE');
  await api('/actions/workflows/pi-dispatcher.yml/dispatches', 'POST', { ref: 'dev' });
  console.log(`Split #${issue} into ${children.map(n => `#${n}`).join(', ')}`);
}

async function main() {
  const [mode, rawIssue, filename] = process.argv.slice(2);
  const issue = Number(rawIssue);
  if (!repo || !token || !['prepare', 'publish'].includes(mode) ||
      !Number.isSafeInteger(issue) || issue < 1 || !filename) {
    throw new Error('usage: pi-architect.mjs {prepare|publish} <issue> <file>');
  }
  if (mode === 'prepare') await prepare(issue, filename);
  else await publish(issue, filename);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

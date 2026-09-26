#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readQueueContext } from './pi-queue-context.mjs';
import { ISSUE_ACTIVE, ISSUE_STATE_LABELS, ISSUE_TERMINAL, PIPELINE_LABELS, issueStateLabels, validateIssueTransition } from './pi-state-machine.mjs';
import { validateArchitectPlanAgainstBacklog } from './pi-architect-plan-validator.mjs';

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
  let toolResult = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'entry_appended' && event.entry?.type === 'custom' &&
        event.entry?.customType === 'architect-result') {
      toolResult = event.entry.data;
    }
    if (event.type !== 'agent_end' || !Array.isArray(event.messages)) continue;
    const assistant = [...event.messages].reverse().find(message => message?.role === 'assistant');
    final = assistant?.content?.filter(part => part?.type === 'text').map(part => part.text).join('') ?? final;
  }
  // Prefer the structured result from the submit_result tool (pi-architect-result-tool.mjs).
  // The ARCHITECT_RESULT text line is kept only as a fallback while that tool
  // is still a prototype.
  if (toolResult) return validatePlan(toolResult, parent);
  const lines = final.split(/\r?\n/).filter(line => line.startsWith('ARCHITECT_RESULT: '));
  if (!lines.length) throw new Error('Expected an ARCHITECT_RESULT line');
  return validatePlan(JSON.parse(lines.at(-1).slice('ARCHITECT_RESULT: '.length)), parent);
}

export function validatePlan(plan, parent) {
  if (plan?.parent_issue !== parent) throw new Error('Plan targets another issue');
  if (plan.action === 'keep' || plan.action === 'revise') {
    if (typeof plan.reason !== 'string' || plan.reason.trim().length < 20 ||
        plan.reason.length > 2000) throw new Error('Review decision needs a concrete reason');
    if (plan.action === 'keep') return plan;
    if (typeof plan.title !== 'string' || plan.title.length < 12 || plan.title.length > 110 ||
        typeof plan.body !== 'string' || plan.body.length < 120 || plan.body.length > 5000 ||
        /<!--\s*architect-/.test(plan.body) || !['P0', 'P1', 'P2'].includes(plan.priority) ||
        !Array.isArray(plan.depends_on) || new Set(plan.depends_on).size !== plan.depends_on.length ||
        !plan.depends_on.every(n => Number.isSafeInteger(n) && n > 0 && n !== parent)) {
      throw new Error('Invalid revised issue or task metadata');
    }
    return plan;
  }
  if (plan.action !== undefined && plan.action !== 'split') {
    throw new Error('Unknown Architect action');
  }
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

export function taskMetadata(number) {
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

async function transitionIssue(issue, action) {
  const expected = await api(`/issues/${issue}`);
  const target = validateIssueTransition(expected, action);
  const current = await api(`/issues/${issue}`);
  const expectedState = issueStateLabels(expected);
  const currentState = issueStateLabels(current);
  if (JSON.stringify(expectedState) !== JSON.stringify(currentState)) {
    throw new Error(`concurrent Architect transition on #${issue}: expected [${expectedState}], found [${currentState}]`);
  }
  const keep = current.labels.map(label => label.name).filter(label => !ISSUE_STATE_LABELS.has(label));
  await api(`/issues/${issue}`, 'PATCH', { labels: [...new Set([...keep, target])] });
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

async function reviseTask(number, plan) {
  const filename = `tasks/${number}.md`;
  const content = `---\nissue: ${number}\npriority: ${plan.priority}\ndepends_on: [${plan.depends_on.join(', ')}]\n---\n\n# ${plan.title}\n\n## Scope and acceptance\n${plan.body}\n`;
  const existing = await api(`/contents/${filename}?ref=dev`);
  if (existing && Buffer.from(existing.content.replace(/\s/g, ''), 'base64').toString('utf8') === content) return;
  await api(`/contents/${filename}`, 'PUT', {
    message: `Refine architect-reviewed task for issue #${number}`,
    content: Buffer.from(content).toString('base64'),
    ...(existing ? { sha: existing.sha } : {}),
    branch: 'dev',
  });
}

async function prepare(issue, filename) {
  const parent = await api(`/issues/${issue}`);
  const labels = new Set(parent?.labels?.map(label => label.name));
  const wasDispatcherReady = labels.has('dispatcher:ready');
  if (parent?.state === 'open' && !labels.has('architect:ready') &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    await ensureLabel('architect:ready', 'c5def5', 'Large issue approved for Pi Architect');
    if (labels.has('dispatcher:ready')) {
      await transitionIssue(issue, 'architect-ready');
    } else {
      throw new Error('Manual Architect dispatch requires dispatcher:ready');
    }
    labels.delete('dispatcher:ready');
    labels.add('architect:ready');
  }
  if (!parent || parent.state !== 'open' || !labels.has('architect:ready') ||
      [...ISSUE_ACTIVE, ...ISSUE_TERMINAL, PIPELINE_LABELS.epic]
        .filter(x => x !== PIPELINE_LABELS.architectReady).some(x => labels.has(x))) {
    throw new Error('Parent must be an open, inactive issue labeled architect:ready');
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
    was_dispatcher_ready: wasDispatcherReady,
    metadata: taskMetadata(issue), open_issues: known, queue,
  }, null, 2));
}

async function publish(issue, jsonl, contextFile) {
  const parent = await api(`/issues/${issue}`);
  const labels = new Set(parent?.labels?.map(label => label.name));
  if (parent?.state !== 'open' || !labels.has('architect:ready') ||
      ['pi:running', 'pi:ready', 'pi:mr-created', 'pi:failed', 'pi:needs-human',
        'pi:blocked', 'pi:cancelled'].some(x => labels.has(x))) {
    throw new Error('Parent changed while Architect was planning');
  }
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  if (context.number !== issue || context.title !== parent.title || context.body !== parent.body ||
      typeof context.was_dispatcher_ready !== 'boolean' ||
      JSON.stringify(context.metadata) !== JSON.stringify(taskMetadata(issue))) {
    throw new Error('Source issue changed while Architect was planning');
  }
  const plan = planFromJsonl(fs.readFileSync(jsonl, 'utf8'), issue);
  const backlog = await allIssues();
  validateArchitectPlanAgainstBacklog(plan, issue, backlog, taskMetadata);
  if (plan.action === 'keep' || plan.action === 'revise') {
    if (childNumbers(parent.body).length) throw new Error('Cannot revise an already split issue');
    if (plan.action === 'revise') {
      await reviseTask(issue, plan);
      const marker = /<!-- architect-parent:\d+; architect-key:[a-z][a-z0-9-]* -->/.exec(parent.body ?? '')?.[0];
      const body = marker ? `${plan.body}\n\n${marker}` : plan.body;
      if (parent.title !== plan.title || parent.body !== body) {
        await api(`/issues/${issue}`, 'PATCH', { title: plan.title, body });
      }
    }
    await api(`/issues/${issue}/comments`, 'POST', {
      body: `Pi Architect review: **${plan.action}**. ${plan.reason}`,
    });
    // A successful Architect keep/revise decision makes the issue executable.
    // This also covers manual workflow_dispatch reviews, where dispatcher:ready
    // may not have existed before Architect temporarily claimed the issue.
    await ensureLabel('dispatcher:ready', 'd4c5f9', 'Eligible for Pi dispatcher selection');
    await transitionIssue(issue, 'queued');
    await api('/actions/workflows/pi-dispatcher.yml/dispatches', 'POST', { ref: 'dev' });
    console.log(`Reviewed #${issue}: ${plan.action}`);
    return;
  }
  const inherited = taskMetadata(issue).dependencies;
  const existing = backlog;
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
  const latestParent = await api(`/issues/${issue}`);
  const latestLabels = new Set(latestParent.labels.map(label => label.name));
  if (latestLabels.has('architect:ready')) {
    const keep = latestParent.labels.map(label => label.name).filter(label => !ISSUE_STATE_LABELS.has(label));
    await api(`/issues/${issue}`, 'PATCH', { labels: keep });
  }
  await api('/actions/workflows/pi-dispatcher.yml/dispatches', 'POST', { ref: 'dev' });
  console.log(`Split #${issue} into ${children.map(n => `#${n}`).join(', ')}`);
}

async function main() {
  const [mode, rawIssue, filename, contextFile] = process.argv.slice(2);
  const issue = Number(rawIssue);
  if (!repo || !token || !['prepare', 'publish'].includes(mode) ||
      !Number.isSafeInteger(issue) || issue < 1 || !filename ||
      (mode === 'publish' && !contextFile)) {
    throw new Error('usage: pi-architect.mjs {prepare|publish} <issue> <file> [context]');
  }
  if (mode === 'prepare') await prepare(issue, filename);
  else await publish(issue, filename, contextFile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

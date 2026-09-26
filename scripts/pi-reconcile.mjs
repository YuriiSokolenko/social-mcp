#!/usr/bin/env node
import { replaceIssueState, replaceReviewState } from './pi-github-state.mjs';
import { ISSUE_STATE_LABELS, inspectIssueState, inspectPrState, safeRemovals } from './pi-state-machine.mjs';
import { checkpointGcDecision, recoveryForIssue, recoveryForPr } from './pi-recovery-policy.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const apply = process.argv.includes('--apply');
const automationMode = process.env.PI_AUTOMATION_MODE ?? 'PAUSED';
const recoveryDispatchAllowed = automationMode === 'RUNNING';
if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');

const base = `https://api.github.com/repos/${repo}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28' };

async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { ...headers, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
async function pages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
async function workflowRunPages(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = data.workflow_runs ?? [];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}
async function replaceStateLabels(number, expected, target, kind) {
  const replace = kind === 'issue' ? replaceIssueState : replaceReviewState;
  await replace({
    number, expected, target, context: 'reconciliation',
    load: n => api(`/issues/${n}`),
    patch: (n, labels) => api(`/issues/${n}`, { method: 'PATCH', body: JSON.stringify({ labels }) }),
  });
}
async function dispatchWorkflow(workflow, inputs) {
  const enriched = { ...inputs };
  if (workflow === 'pi-issue-agent.yml' || workflow === 'pi-architect.yml') {
    const issue = await api(`/issues/${inputs.issue_number}`);
    enriched.issue_title = issue.title;
  } else if (workflow === 'pi-pr-review.yml' || workflow === 'pi-pr-fix.yml') {
    const pr = await api(`/pulls/${inputs.pr_number}`);
    enriched.pr_title = pr.title;
  }
  await api(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'dev', inputs: enriched }) });
}
async function tryDispatchWorkflow(workflow, inputs, context) {
  try {
    await dispatchWorkflow(workflow, inputs);
    return true;
  } catch (error) {
    console.error(`Recovery dispatch failed for ${context}: ${error.message}`);
    return false;
  }
}
async function deleteRef(ref) {
  const response = await fetch(`${base}/git/refs/${ref}`, { method: 'DELETE', headers });
  if (![204, 404].includes(response.status)) throw new Error(`Cannot delete ref ${ref}: ${response.status} ${await response.text()}`);
}
const liveStatuses = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const [allIssues, prs, runGroups, refs] = await Promise.all([
  pages('/issues?state=all'),
  pages('/pulls?state=all'),
  Promise.all(liveStatuses.map(status => workflowRunPages(`/actions/runs?exclude_pull_requests=true&status=${status}`))),
  pages('/git/matching-refs/heads/pi/'),
]);
const runs = runGroups.flat();
const issues = allIssues.filter(item => !item.pull_request);
const openPiPrIssues = new Set(prs.filter(pr => pr.state === 'open' && pr.base.ref === 'dev' &&
  pr.head.repo?.full_name === repo).map(pr => Number(pr.head.ref.match(/^pi\/issue-(\d+)$/)?.[1])).filter(Number.isSafeInteger));

const liveImplementers = new Set();
const liveReviewers = new Set();
const liveRepairs = new Set();
for (const run of runs) {
  if (!liveStatuses.includes(run.status)) continue;
  const implement = /^🤖 Implement #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (implement) liveImplementers.add(Number(implement[1]));
  const review = /^🔬 Review PR #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (review) liveReviewers.add(Number(review[1]));
  const repair = /^🔧 Repair PR #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (repair) liveRepairs.add(Number(repair[1]));
}
const checkpoints = new Set(refs.map(ref => Number(ref.ref.match(/^refs\/heads\/pi\/issue-(\d+)-checkpoint$/)?.[1])).filter(Number.isSafeInteger));
const repairCheckpointRefs = new Map(refs.map(ref => {
  const number = Number(ref.ref.match(/^refs\/heads\/pi\/repair-pr-(\d+)-checkpoint$/)?.[1]);
  return Number.isSafeInteger(number) ? [number, ref] : null;
}).filter(Boolean));

const report = [];
let mergeGateWakeNeeded = false;
for (const issue of issues) {
  const findings = inspectIssueState(issue, {
    hasOpenPiPr: openPiPrIssues.has(issue.number),
    hasLiveImplementer: liveImplementers.has(issue.number),
    hasCheckpoint: checkpoints.has(issue.number),
  });
  const issueLabels = new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
  const retryReadyImplementer = apply && recoveryDispatchAllowed && issue.state === 'open' && issueLabels.has('pi:ready') && !liveImplementers.has(issue.number);
  const retryMergeGateForPr = apply && recoveryDispatchAllowed && issue.state === 'open' && issueLabels.has('pi:mr-created') && openPiPrIssues.has(issue.number);
  if (!findings.length && !retryReadyImplementer && !retryMergeGateForPr) continue;
  const removals = safeRemovals(findings);
  let recovery = null;
  if (apply) {
    if (findings.some(x => x.code === 'orphaned-implementer-state')) {
      recovery = recoveryForIssue(issue, { hasCheckpoint: checkpoints.has(issue.number), hasOpenPiPr: openPiPrIssues.has(issue.number) });
      if (recovery) {
        await replaceStateLabels(issue.number, issue, recovery.add, 'issue');
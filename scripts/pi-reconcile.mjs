#!/usr/bin/env node
import { issueTargetAfterRemovals, replaceIssueState } from './pi-github-state.mjs';
import { inspectIssueState, safeRemovals } from './pi-state-machine.mjs';
import { checkpointGcDecision, recoveryForIssue } from './pi-recovery-policy.mjs';

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
  if (kind !== 'issue') throw new Error(`unsupported reconciliation state kind: ${kind}`);
  await replaceIssueState({
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
const liveArchitects = new Set();
for (const run of runs) {
  if (!liveStatuses.includes(run.status)) continue;
  const implement = /^🤖 Implement #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (implement) liveImplementers.add(Number(implement[1]));
  const architect = /^🏗 Architect #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (architect) liveArchitects.add(Number(architect[1]));
}
const checkpoints = new Set(refs.map(ref => Number(ref.ref.match(/^refs\/heads\/pi\/issue-(\d+)-checkpoint$/)?.[1])).filter(Number.isSafeInteger));
const report = [];
let mergeGateWakeNeeded = false;
for (const issue of issues) {
  const findings = inspectIssueState(issue, {
    hasOpenPiPr: openPiPrIssues.has(issue.number),
    hasLiveImplementer: liveImplementers.has(issue.number),
    hasLiveArchitect: liveArchitects.has(issue.number),
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
        if (recovery.dispatch === 'implementer' && recoveryDispatchAllowed) {
          const dispatched = await tryDispatchWorkflow('pi-issue-agent.yml', { issue_number: String(issue.number) }, `issue #${issue.number}`);
          if (!dispatched) recovery = { ...recovery, dispatch: null, reason: 'implementer recovery dispatch failed; pi:ready retained for retry' };
        }
      }
    } else if (findings.some(x => x.code === 'orphaned-architect-state')) {
      await replaceStateLabels(issue.number, issue, 'pi:needs-human', 'issue');
      recovery = { add: 'pi:needs-human', dispatch: null, reason: 'architect ownership disappeared; human retry required' };
    } else if (removals.length) {
      await replaceStateLabels(issue.number, issue, issueTargetAfterRemovals(issue, removals), 'issue');
    }
  }
  if (retryMergeGateForPr) mergeGateWakeNeeded = true;
  if (retryReadyImplementer && !recovery) {
    await replaceStateLabels(issue.number, issue, 'dispatcher:ready', 'issue');
    const dispatched = await tryDispatchWorkflow('pi-dispatcher.yml', {}, `ready issue #${issue.number}`);
    recovery = { add: 'dispatcher:ready', dispatch: dispatched ? 'dispatcher' : null, reason: dispatched ? 'return stranded ready issue to serialized dispatcher' : 'dispatcher wake failed; dispatcher:ready retained for retry' };
  }
  report.push({ type: 'issue', number: issue.number, title: issue.title, findings, removals, recovery });
}
for (const pr of prs) {
  if (pr.state !== 'open') continue;
  const issueNumber = Number(pr.head?.ref?.match(/^pi\/issue-(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(issueNumber)) continue;

  const issue = issues.find(item => item.number === issueNumber);
  const issueLabels = new Set((issue?.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
  if (!issue || issue.state !== 'open' || !issueLabels.has('pi:mr-created') || issueLabels.has('pi:needs-human')) continue;

  // Review/integration/repair progress is SHA+base-bound commit status owned by
  // the merge gate. Reconciliation only needs to wake that scheduler; it must
  // not recreate the removed review:* label state machine.
  if (apply && recoveryDispatchAllowed) mergeGateWakeNeeded = true;
  report.push({
    type: 'pr',
    number: pr.number,
    title: pr.title,
    findings: [],
    removals: [],
    recovery: apply ? {
      add: null,
      dispatch: recoveryDispatchAllowed ? 'merge-gate' : null,
      reason: recoveryDispatchAllowed ? 'resume durable PR pipeline through merge gate' : 'PR recovery deferred until RUNNING',
    } : null,
  });
}

if (apply && recoveryDispatchAllowed && mergeGateWakeNeeded) {
  const gateAlreadyLive = runs.some(run =>
    run.path === '.github/workflows/pi-auto-merge.yml' && liveStatuses.includes(run.status));
  if (gateAlreadyLive) {
    console.log('Merge Gate is already queued/running; skipping duplicate reconciler wake');
  } else {
    await tryDispatchWorkflow('pi-auto-merge.yml', {}, 'saved PR/review state');
  }
}

if (apply) {
  for (const number of checkpoints) {
    const issue = issues.find(item => item.number === number);
    const decision = checkpointGcDecision(issue, { hasOpenPiPr: openPiPrIssues.has(number) });
    if (decision.remove) {
      await deleteRef(`heads/pi/issue-${number}-checkpoint`);
      report.push({ type: 'checkpoint', number, title: decision.reason, findings: [{ code: 'checkpoint-gc', severity: 'repair' }], removals: [], recovery: null });
    }
  }
}

console.log(`Pipeline reconciler: ${report.length} object(s) need attention; mode=${apply ? 'apply-safe-repairs' : 'audit'}; automation=${automationMode}; recovery-dispatch=${recoveryDispatchAllowed ? 'enabled' : 'deferred'}`);
for (const item of report) {
  console.log(`${item.type.toUpperCase()} #${item.number} ${item.title}`);
  for (const finding of item.findings) console.log(`  - ${finding.severity}: ${finding.code}${finding.labels ? ` [${finding.labels.join(', ')}]` : ''}`);
  if (apply && item.removals.length) console.log(`  repaired: removed ${item.removals.join(', ')}`);
  if (item.recovery) console.log(`  recovery: ${item.recovery.add}${item.recovery.dispatch ? ` + ${item.recovery.dispatch}` : ''} (${item.recovery.reason})`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import('node:fs');
  const lines = ['## Pipeline reconciliation', '', `Mode: **${apply ? 'safe repair' : 'audit'}** · Findings: **${report.length}**`, ''];
  for (const item of report) lines.push(`- **${item.type} #${item.number}** — ${item.findings.map(x => x.code).join(', ')}${item.removals.length ? `; safe removals: ${item.removals.join(', ')}` : ''}`);
  if (!report.length) lines.push('No inconsistent pipeline state found.');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
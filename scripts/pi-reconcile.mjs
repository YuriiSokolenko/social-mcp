#!/usr/bin/env node
import { inspectIssueState, inspectPrState, safeRemovals } from './pi-state-machine.mjs';
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
async function addLabel(number, label) {
  await api(`/issues/${number}/labels`, { method: 'POST', body: JSON.stringify({ labels: [label] }) });
}
async function dispatchWorkflow(workflow, inputs) {
  await api(`/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'dev', inputs }) });
}
async function deleteRef(ref) {
  const response = await fetch(`${base}/git/refs/${ref}`, { method: 'DELETE', headers });
  if (![204, 404].includes(response.status)) throw new Error(`Cannot delete ref ${ref}: ${response.status} ${await response.text()}`);
}
async function removeLabel(number, label) {
  const response = await fetch(`${base}/issues/${number}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE', headers,
  });
  if (![200, 204, 404].includes(response.status)) {
    throw new Error(`Cannot remove ${label} from #${number}: ${response.status} ${await response.text()}`);
  }
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
  if (run.name === 'Pi Issue Agent' && implement) liveImplementers.add(Number(implement[1]));
  const review = /^🔬 Review PR #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (run.name === 'Pi PR Review' && review) liveReviewers.add(Number(review[1]));
  const repair = /^🔧 Repair PR #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (run.name === 'Pi PR Fix' && repair) liveRepairs.add(Number(repair[1]));
}
const checkpoints = new Set(refs.map(ref => Number(ref.ref.match(/^refs\/heads\/pi\/issue-(\d+)-checkpoint$/)?.[1])).filter(Number.isSafeInteger));
const repairCheckpointRefs = new Map(refs.map(ref => {
  const number = Number(ref.ref.match(/^refs\/heads\/pi\/repair-pr-(\d+)-checkpoint$/)?.[1]);
  return Number.isSafeInteger(number) ? [number, ref] : null;
}).filter(Boolean));

const report = [];
for (const issue of issues) {
  const findings = inspectIssueState(issue, {
    hasOpenPiPr: openPiPrIssues.has(issue.number),
    hasLiveImplementer: liveImplementers.has(issue.number),
    hasCheckpoint: checkpoints.has(issue.number),
  });
  if (!findings.length) continue;
  const removals = safeRemovals(findings);
  let recovery = null;
  if (apply) {
    for (const label of removals) await removeLabel(issue.number, label);
    if (findings.some(x => x.code === 'orphaned-implementer-state')) {
      recovery = recoveryForIssue(issue, { hasCheckpoint: checkpoints.has(issue.number), hasOpenPiPr: openPiPrIssues.has(issue.number) });
      if (recovery) {
        await addLabel(issue.number, recovery.add);
        if (recovery.dispatch === 'implementer' && recoveryDispatchAllowed) {
          await dispatchWorkflow('pi-issue-agent.yml', { issue_number: String(issue.number) });
        }
      }
    }
  }
  report.push({ type: 'issue', number: issue.number, title: issue.title, findings, removals, recovery });
}
for (const pr of prs) {
  const repairCheckpoint = repairCheckpointRefs.get(pr.number);
  if (repairCheckpoint && pr.state === 'open' && !liveRepairs.has(pr.number)) {
    if (apply) {
      await dispatchWorkflow('pi-pr-fix.yml', { pr_number: String(pr.number), reason: 'review' });
    }
    report.push({ type: 'repair', number: pr.number, title: pr.title,
      findings: [{ code: 'orphaned-repair-checkpoint', severity: 'repair', checkpoint: true }],
      removals: [], recovery: apply ? { add: null, dispatch: 'repair', reason: 'resume saved repair checkpoint' } : null });
  }
  const findings = inspectPrState(pr, { hasLiveReviewer: liveReviewers.has(pr.number) });
  if (!findings.length) continue;
  const removals = safeRemovals(findings);
  let recovery = null;
  if (apply) {
    for (const label of removals) await removeLabel(pr.number, label);
    if (findings.some(x => x.code === 'orphaned-review-state')) {
      recovery = recoveryForPr(pr);
      if (recovery) {
        await addLabel(pr.number, recovery.add);
        if (recovery.dispatch === 'reviewer' && recoveryDispatchAllowed) {
          await dispatchWorkflow('pi-pr-review.yml', { pr_number: String(pr.number) });
        }
      }
    }
  }
  report.push({ type: 'pr', number: pr.number, title: pr.title, findings, removals, recovery });
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
  if (item.findings.some(finding => finding.checkpoint)) console.log('  checkpoint preserved: saved implementation work may exist');
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import('node:fs');
  const lines = ['## Pipeline reconciliation', '', `Mode: **${apply ? 'safe repair' : 'audit'}** · Findings: **${report.length}**`, ''];
  for (const item of report) lines.push(`- **${item.type} #${item.number}** — ${item.findings.map(x => x.code).join(', ')}${item.removals.length ? `; safe removals: ${item.removals.join(', ')}` : ''}`);
  if (!report.length) lines.push('No inconsistent pipeline state found.');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

#!/usr/bin/env node
import { inspectIssueState, inspectPrState, safeRemovals } from './pi-state-machine.mjs';
import { checkpointGcDecision, recoveryForIssue, recoveryForPr } from './pi-recovery-policy.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const apply = process.argv.includes('--apply');
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
async function addLabel(number, label) {
  await api(`/issues/${number}/labels`, { method: 'POST', body: JSON.stringify({ labels: [label] }) });
}
async function markerExists(sha, context) {
  const statuses = await api(`/commits/${sha}/statuses?per_page=100`);
  return statuses.some(status => status.context === context && status.state === 'success');
}
async function mark(sha, context, description) {
  await api(`/statuses/${sha}`, { method: 'POST', body: JSON.stringify({ state: 'success', context, description: description.slice(0, 140) }) });
}
async function dispatch(event_type, payload) {
  await api('/dispatches', { method: 'POST', body: JSON.stringify({ event_type, client_payload: payload }) });
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

const [allIssues, prs, runs, refs] = await Promise.all([
  pages('/issues?state=all'),
  pages('/pulls?state=all'),
  pages('/actions/runs?exclude_pull_requests=true'),
  pages('/git/matching-refs/heads/pi/issue-'),
]);
const issues = allIssues.filter(item => !item.pull_request);
const openPiPrIssues = new Set(prs.filter(pr => pr.state === 'open' && pr.base.ref === 'dev' &&
  pr.head.repo?.full_name === repo).map(pr => Number(pr.head.ref.match(/^pi\/issue-(\d+)$/)?.[1])).filter(Number.isSafeInteger));

const liveImplementers = new Set();
const liveReviewers = new Set();
for (const run of runs) {
  if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) continue;
  const implement = /^🤖 Implement #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (run.name === 'Pi Issue Agent' && implement) liveImplementers.add(Number(implement[1]));
  const review = /^🔬 Review PR #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (run.name === 'Pi PR Review' && review) liveReviewers.add(Number(review[1]));
}
const checkpoints = new Set(refs.map(ref => Number(ref.ref.match(/^refs\/heads\/pi\/issue-(\d+)-checkpoint$/)?.[1])).filter(Number.isSafeInteger));

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
        if (recovery.dispatch === 'implementer') {
          const checkpointRef = refs.find(ref => ref.ref === `refs/heads/pi/issue-${issue.number}-checkpoint`);
          const markerSha = checkpointRef?.object?.sha ?? (await api('/git/ref/heads/dev')).object.sha;
          const context = `social-mcp/recovery-implement-${issue.number}`;
          if (!await markerExists(markerSha, context)) {
            await mark(markerSha, context, `Implementer recovery dispatched for issue #${issue.number}`);
            await dispatch('pi_dispatch_issue', { issue_number: issue.number, issue_title: issue.title });
          }
        }
      }
    }
  }
  report.push({ type: 'issue', number: issue.number, title: issue.title, findings, removals, recovery });
}
for (const pr of prs) {
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
        if (recovery.dispatch === 'reviewer') {
          const context = `social-mcp/recovery-review-${pr.number}`;
          if (!await markerExists(pr.head.sha, context)) {
            await mark(pr.head.sha, context, `Reviewer recovery dispatched for PR #${pr.number}`);
            await dispatch('pi_pr_review', { pr_number: pr.number, pr_title: pr.title });
          }
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

console.log(`Pipeline reconciler: ${report.length} object(s) need attention; mode=${apply ? 'apply-safe-repairs' : 'audit'}`);
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

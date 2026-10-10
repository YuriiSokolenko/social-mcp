#!/usr/bin/env node
import { issueStateIo, issueTargetAfterRemovals, replaceIssueState } from './pi-common/github-state.mjs';
import { PIPELINE_LABELS, inspectIssueState, issueStateLabels, safeRemovals } from './pi-common/state-machine.mjs';
import { REVIEW_CHANGES_REQUESTED, REVIEW_PASSED } from './pi-common/pr-labels.mjs';
import { baseBranch, issueBranchPrefix, parseCheckpointRef, parseIssueBranch, checkpointBranch, workflowFile } from './pi-common/project-config.mjs';
import { checkpointGcDecision, issueRecoveryTarget } from './pi-common/recovery-policy.mjs';
import { githubClient } from './pi-common/github-api.mjs';

const apply = process.argv.includes('--apply');
const automationMode = process.env.PI_AUTOMATION_MODE ?? 'PAUSED';
const issueRecoveryAllowed = automationMode === 'RUNNING';
const prRecoveryAllowed = automationMode === 'RUNNING' || automationMode === 'DRAINING';
const RECOVERY_GRACE_MS = 10 * 60 * 1000;
const { api, pages, repo, dispatchWorkflow, workflowRuns, deleteRef } = githubClient();

async function replaceStateLabels(number, expected, target, kind) {
  if (kind !== 'issue') throw new Error(`unsupported reconciliation state kind: ${kind}`);
  await replaceIssueState({ number, expected, target, context: 'reconciliation', ...issueStateIo(api) });
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
const liveStatuses = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const [allIssues, prs, runGroups, refs] = await Promise.all([
  pages('/issues?state=all'),
  pages('/pulls?state=all'),
  Promise.all(liveStatuses.map(status => workflowRuns(`/actions/runs?exclude_pull_requests=true&status=${status}`))),
  pages(`/git/matching-refs/heads/${issueBranchPrefix().split('/')[0]}/`),
]);
const runs = runGroups.flat();
const issues = allIssues.filter(item => !item.pull_request);
const openPiPrIssues = new Set(prs.filter(pr => pr.state === 'open' && pr.base.ref === baseBranch() &&
  pr.head.repo?.full_name === repo).map(pr => parseIssueBranch(pr.head.ref, { strict: false })).filter(Number.isSafeInteger));

const liveImplementers = new Set();
const liveArchitects = new Set();
const liveReviews = new Set();
const liveFixes = new Set();
for (const run of runs) {
  if (!liveStatuses.includes(run.status)) continue;
  const implement = /^🤖 Implement #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (implement) liveImplementers.add(Number(implement[1]));
  const architect = /^🏗 Architect #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (architect) liveArchitects.add(Number(architect[1]));
  const review = /^🔬 Review PR #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (review) liveReviews.add(Number(review[1]));
  const fix = /^🔧 (?:Repair|Fix) PR #(\d+)\b/.exec(run.display_title ?? run.name ?? '');
  if (fix) liveFixes.add(Number(fix[1]));
}
const checkpoints = new Set(refs.map(ref => parseCheckpointRef(ref.ref)).filter(Number.isSafeInteger));
const report = [];
for (const issue of issues) {
  const findings = inspectIssueState(issue, {
    hasOpenPiPr: openPiPrIssues.has(issue.number),
    hasLiveImplementer: liveImplementers.has(issue.number),
    hasLiveArchitect: liveArchitects.has(issue.number),
    hasCheckpoint: checkpoints.has(issue.number),
  });
  const labels = new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
  const issueAgeMs = Date.now() - Date.parse(issue.updated_at ?? issue.created_at);
  const strandedReady = issue.state === 'open' && labels.has(PIPELINE_LABELS.ready) &&
    Number.isFinite(issueAgeMs) && issueAgeMs >= RECOVERY_GRACE_MS &&
    !liveImplementers.has(issue.number) && !openPiPrIssues.has(issue.number);

  if (!findings.length && !strandedReady) continue;
  const removals = safeRemovals(findings);
  let recovery = null;

  if (apply) {
    const lostOwner = findings.some(item =>
      item.code === 'orphaned-implementer-state' || item.code === 'orphaned-architect-state');
    if (lostOwner || strandedReady) {
      const target = issueRecoveryTarget(issue, {
        hasOpenPiPr: openPiPrIssues.has(issue.number),
        automationMode,
      });
      await replaceStateLabels(issue.number, issue, target, 'issue');
      recovery = {
        add: target,
        dispatch: null,
        reason: target === PIPELINE_LABELS.pr
          ? 'published PR is the durable owner'
          : target === PIPELINE_LABELS.queued
            ? 'return lost issue ownership to the normal Dispatcher'
            : `${automationMode}: clear lost issue ownership without re-queueing`,
      };
    } else if (removals.length) {
      await replaceStateLabels(issue.number, issue, issueTargetAfterRemovals(issue, removals), 'issue');
    }
  }

  report.push({ type: 'issue', number: issue.number, title: issue.title, findings, removals, recovery });
}

// A split parent is the durable transaction marker. Repair any child that was
// created but not labeled because Architect publication was interrupted.
const childrenOfEpic = (body) => {
  const match = /<!-- architect-children:([1-9]\d*(?:,[1-9]\d*)*) -->/.exec(body ?? '');
  return match ? match[1].split(',').map(Number) : [];
};
for (const parent of issues) {
  const labels = new Set((parent.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
  if (parent.state !== 'open' || !labels.has(PIPELINE_LABELS.epic)) continue;
  for (const number of childrenOfEpic(parent.body)) {
    const child = issues.find(item => item.number === number);
    if (!child || child.state !== 'open' || issueStateLabels(child).length) continue;
    let recovery = null;
    if (apply && issueRecoveryAllowed) {
      await replaceStateLabels(number, child, PIPELINE_LABELS.queued, 'issue');
      recovery = { add: PIPELINE_LABELS.queued, dispatch: null, reason: 'complete interrupted Architect split publication' };
    }
    report.push({
      type: 'issue', number, title: child.title,
      findings: [{ code: 'partial-architect-split-child', severity: 'repair' }],
      removals: [], recovery,
    });
  }
}

let mergeGateRecoveryNeeded = false;
if (apply && prRecoveryAllowed) {
  for (const pr of prs) {
    if (pr.state !== 'open' || pr.draft || pr.base.ref !== baseBranch() || pr.head.repo?.full_name !== repo ||
        parseIssueBranch(pr.head.ref ?? '') === null) continue;
    const labels = new Set((pr.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
    const prAgeMs = Date.now() - Date.parse(pr.updated_at ?? pr.created_at);
    if (!Number.isFinite(prAgeMs) || prAgeMs < RECOVERY_GRACE_MS) continue;
    if (labels.has(PIPELINE_LABELS.needsHuman) || liveReviews.has(pr.number) || liveFixes.has(pr.number)) continue;
    if (labels.has(REVIEW_PASSED)) {
      mergeGateRecoveryNeeded = true;
      report.push({
        type: 'pr',
        number: pr.number,
        title: pr.title,
        findings: [{ code: 'passed-pr-needs-merge-gate', severity: 'repair' }],
        removals: [],
        recovery: { add: REVIEW_PASSED, dispatch: 'Merge Gate', reason: 'wake shared merge scan after lost PASS handoff' },
      });
      continue;
    }
    const needsFix = labels.has(REVIEW_CHANGES_REQUESTED);
    const workflow = workflowFile(needsFix ? 'repair' : 'reviewer');
    const owner = needsFix ? 'PR Fix' : 'Reviewer';
    const dispatched = await tryDispatchWorkflow(workflow, { pr_number: String(pr.number) }, `PR #${pr.number}`);
    report.push({
      type: 'pr',
      number: pr.number,
      title: pr.title,
      findings: [{ code: 'orphaned-pr-pipeline', severity: 'repair' }],
      removals: [],
      recovery: {
        add: needsFix ? REVIEW_CHANGES_REQUESTED : 'unreviewed',
        dispatch: dispatched ? owner : null,
        reason: dispatched ? `restart stranded ${owner}` : `${owner} recovery dispatch failed`,
      },
    });
  }
  if (mergeGateRecoveryNeeded) {
    await tryDispatchWorkflow(workflowFile('mergeGate'), undefined, 'passed PR merge gate');
  }
}

if (apply) {
  for (const number of checkpoints) {
    const issue = issues.find(item => item.number === number);
    const decision = checkpointGcDecision(issue, { hasOpenPiPr: openPiPrIssues.has(number) });
    if (decision.remove) {
      await deleteRef(`heads/${checkpointBranch(number)}`);
      report.push({ type: 'checkpoint', number, title: decision.reason, findings: [{ code: 'checkpoint-gc', severity: 'repair' }], removals: [], recovery: null });
    }
  }
}

console.log(`Pipeline reconciler: ${report.length} object(s) need attention; mode=${apply ? 'apply-safe-repairs' : 'audit'}; automation=${automationMode}; issue-recovery=${issueRecoveryAllowed ? 'enabled' : 'deferred'}; pr-recovery=${prRecoveryAllowed ? 'enabled' : 'deferred'}`);
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
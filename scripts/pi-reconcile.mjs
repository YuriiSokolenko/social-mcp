#!/usr/bin/env node
import { issueTargetAfterRemovals, replaceIssueState } from './pi-common/github-state.mjs';
import { inspectIssueState, issueStateLabels, safeRemovals } from './pi-common/state-machine.mjs';
import { checkpointGcDecision, recoveryForIssue } from './pi-common/recovery-policy.mjs';
import { githubClient } from './pi-common/github-api.mjs';

const apply = process.argv.includes('--apply');
const automationMode = process.env.PI_AUTOMATION_MODE ?? 'PAUSED';
const issueRecoveryAllowed = automationMode === 'RUNNING';
const prRecoveryAllowed = automationMode === 'RUNNING' || automationMode === 'DRAINING';
const RECOVERY_GRACE_MS = 10 * 60 * 1000;
const { api, pages, repo, dispatchWorkflow, workflowRuns, deleteRef } = githubClient();

async function replaceStateLabels(number, expected, target, kind) {
  if (kind !== 'issue') throw new Error(`unsupported reconciliation state kind: ${kind}`);
  await replaceIssueState({
    number, expected, target, context: 'reconciliation',
    load: n => api(`/issues/${n}`),
    patch: (n, labels) => api(`/issues/${n}`, 'PATCH', { labels }),
  });
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
  pages('/git/matching-refs/heads/pi/'),
]);
const runs = runGroups.flat();
const issues = allIssues.filter(item => !item.pull_request);
const openPiPrIssues = new Set(prs.filter(pr => pr.state === 'open' && pr.base.ref === 'dev' &&
  pr.head.repo?.full_name === repo).map(pr => Number(pr.head.ref.match(/^pi\/issue-(\d+)$/)?.[1])).filter(Number.isSafeInteger));

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
const checkpoints = new Set(refs.map(ref => Number(ref.ref.match(/^refs\/heads\/pi\/issue-(\d+)-checkpoint$/)?.[1])).filter(Number.isSafeInteger));
const report = [];
for (const issue of issues) {
  const findings = inspectIssueState(issue, {
    hasOpenPiPr: openPiPrIssues.has(issue.number),
    hasLiveImplementer: liveImplementers.has(issue.number),
    hasLiveArchitect: liveArchitects.has(issue.number),
    hasCheckpoint: checkpoints.has(issue.number),
  });
  const issueLabels = new Set((issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
  const issueAgeMs = Date.now() - Date.parse(issue.updated_at ?? issue.created_at);
  const retryReadyImplementer = apply && issueRecoveryAllowed && issue.state === 'open' && issueLabels.has('pi:ready') &&
    Number.isFinite(issueAgeMs) && issueAgeMs >= RECOVERY_GRACE_MS &&
    !liveImplementers.has(issue.number) && !openPiPrIssues.has(issue.number);
  if (!findings.length && !retryReadyImplementer) continue;
  const removals = safeRemovals(findings);
  let recovery = null;
  if (apply) {
    if (findings.some(x => x.code === 'orphaned-implementer-state')) {
      if (issueRecoveryAllowed) {
        recovery = recoveryForIssue(issue, { hasCheckpoint: checkpoints.has(issue.number), hasOpenPiPr: openPiPrIssues.has(issue.number) });
        if (recovery) {
          await replaceStateLabels(issue.number, issue, recovery.add, 'issue');
          if (recovery.dispatch === 'implementer') {
            const dispatched = await tryDispatchWorkflow('pi-issue-agent.yml', { issue_number: String(issue.number) }, `issue #${issue.number}`);
            if (!dispatched) recovery = { ...recovery, dispatch: null, reason: 'implementer recovery dispatch failed; pi:ready retained for retry' };
          }
        }
      } else {
        await replaceStateLabels(issue.number, issue, null, 'issue');
        recovery = { add: null, dispatch: null, reason: `${automationMode}: clear orphaned implementer ownership without re-queueing` };
      }
    } else if (findings.some(x => x.code === 'orphaned-architect-state')) {
      const target = issueRecoveryAllowed ? 'dispatcher:ready' : null;
      await replaceStateLabels(issue.number, issue, target, 'issue');
      recovery = {
        add: target,
        dispatch: null,
        reason: issueRecoveryAllowed
          ? 'return orphaned architect ownership to dispatcher'
          : `${automationMode}: clear orphaned architect ownership without re-queueing`,
      };
    } else if (removals.length) {
      await replaceStateLabels(issue.number, issue, issueTargetAfterRemovals(issue, removals), 'issue');
    }
  }
  if (retryReadyImplementer && !recovery) {
    const dispatched = await tryDispatchWorkflow(
      'pi-issue-agent.yml',
      { issue_number: String(issue.number) },
      `ready issue #${issue.number}`,
    );
    recovery = {
      add: 'pi:ready',
      dispatch: dispatched ? 'implementer' : null,
      reason: dispatched ? 'restart stranded ready implementation' : 'implementer wake failed; pi:ready retained for retry',
    };
  }
  report.push({ type: 'issue', number: issue.number, title: issue.title, findings, removals, recovery });
}

// A split parent is the durable transaction marker. Repair any child that was
// created but not labeled because Architect publication was interrupted.
const childrenOfEpic = (body) => {
  const match = /<!-- architect-children:([1-9]\\d*(?:,[1-9]\\d*)*) -->/.exec(body ?? '');
  return match ? match[1].split(',').map(Number) : [];
};
for (const parent of issues) {
  const labels = new Set((parent.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
  if (parent.state !== 'open' || !labels.has('architect:epic')) continue;
  for (const number of childrenOfEpic(parent.body)) {
    const child = issues.find(item => item.number === number);
    if (!child || child.state !== 'open' || issueStateLabels(child).length) continue;
    let recovery = null;
    if (apply && issueRecoveryAllowed) {
      await replaceStateLabels(number, child, 'dispatcher:ready', 'issue');
      recovery = { add: 'dispatcher:ready', dispatch: null, reason: 'complete interrupted Architect split publication' };
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
    if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'dev' || pr.head.repo?.full_name !== repo ||
        !/^pi\/issue-[1-9]\d*$/.test(pr.head.ref ?? '')) continue;
    const labels = new Set((pr.labels ?? []).map(label => typeof label === 'string' ? label : label.name));
    const prAgeMs = Date.now() - Date.parse(pr.updated_at ?? pr.created_at);
    if (!Number.isFinite(prAgeMs) || prAgeMs < RECOVERY_GRACE_MS) continue;
    if (labels.has('pi:needs-human') || liveReviews.has(pr.number) || liveFixes.has(pr.number)) continue;
    if (labels.has('review:passed')) {
      mergeGateRecoveryNeeded = true;
      report.push({
        type: 'pr',
        number: pr.number,
        title: pr.title,
        findings: [{ code: 'passed-pr-needs-merge-gate', severity: 'repair' }],
        removals: [],
        recovery: { add: 'review:passed', dispatch: 'Merge Gate', reason: 'wake shared merge scan after lost PASS handoff' },
      });
      continue;
    }
    const workflow = labels.has('review:changes-requested') ? 'pi-pr-fix.yml' : 'pi-pr-review.yml';
    const owner = workflow === 'pi-pr-fix.yml' ? 'PR Fix' : 'Reviewer';
    const dispatched = await tryDispatchWorkflow(workflow, { pr_number: String(pr.number) }, `PR #${pr.number}`);
    report.push({
      type: 'pr',
      number: pr.number,
      title: pr.title,
      findings: [{ code: 'orphaned-pr-pipeline', severity: 'repair' }],
      removals: [],
      recovery: {
        add: labels.has('review:changes-requested') ? 'review:changes-requested' : 'unreviewed',
        dispatch: dispatched ? owner : null,
        reason: dispatched ? `restart stranded ${owner}` : `${owner} recovery dispatch failed`,
      },
    });
  }
  if (mergeGateRecoveryNeeded) {
    await tryDispatchWorkflow('pi-auto-merge.yml', undefined, 'passed PR merge gate');
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
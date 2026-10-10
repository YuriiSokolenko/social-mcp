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

const startedAt = performance.now();
const asBoundedInt = (key, fallback, max) => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(key + ' must be a positive integer <= ' + max);
  }
  return value;
};
const deadlineMs = asBoundedInt('PI_RECONCILE_DEADLINE_MS', 255000, 270000);
const slowMs = asBoundedInt('PI_RECONCILE_SLOW_MS', 10000, 270000);
const heartbeatMs = asBoundedInt('PI_RECONCILE_HEARTBEAT_MS', 5000, 270000);
const controller = new AbortController();
const pending = new Map();
const pageCounts = new Map();
const successfulMutations = [];
let currentStage = 'startup';
let currentMutation = null;
const safeNumber = key => /^\d+$/.test(process.env[key] ?? '') ? process.env[key] : 'local';
const elapsed = () => Math.round(performance.now() - startedAt);
function emit(event, fields = {}, warning = false) {
  const record = {
    event, run_id: safeNumber('GITHUB_RUN_ID'),
    run_attempt: safeNumber('GITHUB_RUN_ATTEMPT'),
    mode: apply ? 'apply' : 'audit',
    automation: ['RUNNING', 'DRAINING', 'PAUSED'].includes(automationMode) ? automationMode : 'unknown',
    stage: currentStage, elapsed_ms: elapsed(), remaining_ms: Math.max(0, deadlineMs - elapsed()), ...fields,
  };
  (warning ? console.error : console.log)(
    (warning ? 'RECONCILE_WARN ' : 'RECONCILE_PROGRESS ') + JSON.stringify(record),
  );
}
function errorCategory(error) {
  if (controller.signal.aborted) return 'deadline_exceeded';
  if (/timed out after \d+ms|TimeoutError/i.test(error?.message ?? '')) return 'request_timeout';
  const status = /:\s*(429|5\d\d|4\d\d)\b/.exec(error?.message ?? '');
  if (status) return 'http_' + status[1];
  return 'transport_or_state_error';
}
const requestFields = info => ({
  endpoint: info.category, method: info.method,
  ...(info.page ? { page: info.page } : {}),
  ...(info.status ? { status: info.status } : {}),
});
function onRequest(info) {
  if (info.event === 'start') {
    pending.set(info.id, { ...info, started: performance.now(), warned: false });
    return;
  }
  pending.delete(info.id);
  if (info.event === 'error') {
    emit('request_failed', { ...requestFields(info), duration_ms: info.durationMs, cause: info.cause }, true);
  } else {
    if (info.code >= 400) {
      emit('http_error', { ...requestFields(info), duration_ms: info.durationMs, code: info.code }, true);
    }
    if (info.durationMs >= slowMs) {
      emit('slow_request', { ...requestFields(info), duration_ms: info.durationMs, code: info.code }, true);
    }
  }
}
function onPage(info) {
  const name = info.category === 'workflow-runs' ? 'runs:' + info.status : info.category;
  pageCounts.set(name, (pageCounts.get(name) ?? 0) + 1);
}
const deadlineTimer = setTimeout(() => controller.abort(new Error('reconciler deadline exceeded')), deadlineMs);
const heartbeatTimer = setInterval(() => {
  const waits = [...pending.values()];
  for (const wait of waits) {
    const duration = Math.round(performance.now() - wait.started);
    if (!wait.warned && duration >= slowMs) {
      wait.warned = true;
      emit('slow_request_pending', { ...requestFields(wait), duration_ms: duration }, true);
    }
  }
  emit('heartbeat', {
    pending_total: waits.length,
    pending: waits.slice(0, 12).map(wait => ({
      ...requestFields(wait), duration_ms: Math.round(performance.now() - wait.started),
    })),
    ...(currentMutation ? { mutation: currentMutation } : {}),
  });
}, heartbeatMs);
const { api, pages, repo, dispatchWorkflow, workflowRuns, deleteRef } = githubClient({
  signal: controller.signal, onRequest, onPage,
});
emit('start', { deadline_ms: deadlineMs, slow_ms: slowMs, heartbeat_ms: heartbeatMs });

async function phase(name, task, counts = () => ({})) {
  currentStage = name;
  const at = performance.now();
  emit('phase_start');
  let abort;
  const deadline = new Promise((_, reject) => {
    abort = () => reject(new Error('reconciler deadline exceeded'));
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  try {
    const result = await Promise.race([Promise.resolve().then(task), deadline]);
    emit('phase_end', { status: 'ok', duration_ms: Math.round(performance.now() - at), ...counts() });
    return result;
  } catch (error) {
    emit('phase_end', {
      status: 'failed', duration_ms: Math.round(performance.now() - at),
      cause: errorCategory(error), ...counts(),
    });
    throw error;
  } finally {
    controller.signal.removeEventListener('abort', abort);
  }
}
async function collection(name, task) {
  const at = performance.now();
  emit('collection_start', { collection: name });
  const result = await task();
  emit('collection_end', {
    collection: name, pages: pageCounts.get(name) ?? 0,
    items: result.length, duration_ms: Math.round(performance.now() - at),
  });
  return result;
}
async function mutation(kind, number, action, task) {
  const safeId = { kind, number, action };
  currentMutation = safeId;
  try {
    await task();
    successfulMutations.push(safeId);
  } catch (error) {
    emit('mutation_failed', {
      ...safeId, cause: errorCategory(error), completed_count: successfulMutations.length,
      recently_completed: successfulMutations.slice(-8),
    }, true);
    throw error;
  } finally {
    currentMutation = null;
  }
}


async function replaceStateLabels(number, expected, target, kind) {
  if (kind !== 'issue') throw new Error(`unsupported reconciliation state kind: ${kind}`);
  await replaceIssueState({ number, expected, target, context: 'reconciliation', ...issueStateIo(api) });
}
async function tryDispatchWorkflow(workflow, inputs) {
  // A failed dispatch makes the apply incomplete. Do not claim success.
  await dispatchWorkflow(workflow, inputs);
  return true;
}
async function reconcile() {
const liveStatuses = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const [allIssues, prs, runGroups, refs] = await phase('github-snapshot', () => Promise.all([
  collection('issues', () => pages('/issues?state=all')),
  collection('pulls', () => pages('/pulls?state=all')),
  Promise.all(liveStatuses.map(status => collection('runs:' + status,
    () => workflowRuns(`/actions/runs?exclude_pull_requests=true&status=${status}`)))),
  collection('issue-refs', () => pages(`/git/matching-refs/heads/${issueBranchPrefix().split('/')[0]}/`)),
]), () => ({ collections: 8, pages: [...pageCounts.values()].reduce((a, b) => a + b, 0) }));
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
const pendingRepairs = [];
const issuesByNumber = new Map(issues.map(issue => [issue.number, issue]));
await phase('issue-inspection', async () => {
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
  const entry = { type: 'issue', number: issue.number, title: issue.title,
    findings, removals, recovery: null };
  report.push(entry);
  if (apply) {
    const lostOwner = findings.some(item =>
      item.code === 'orphaned-implementer-state' || item.code === 'orphaned-architect-state');
    if (lostOwner || strandedReady) {
      const target = issueRecoveryTarget(issue, {
        hasOpenPiPr: openPiPrIssues.has(issue.number), automationMode,
      });
      const recovery = {
        add: target, dispatch: null,
        reason: target === PIPELINE_LABELS.pr
          ? 'published PR is the durable owner'
          : target === PIPELINE_LABELS.queued
            ? 'return lost issue ownership to the normal Dispatcher'
            : automationMode + ': clear lost issue ownership without re-queueing',
      };
      pendingRepairs.push({ number: issue.number, expected: issue, target, entry, recovery });
    } else if (removals.length) {
      pendingRepairs.push({
        number: issue.number, expected: issue, target: issueTargetAfterRemovals(issue, removals),
        entry, recovery: null,
      });
    }
  }
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
    const child = issuesByNumber.get(number);
    if (!child || child.state !== 'open' || issueStateLabels(child).length) continue;
    let recovery = null;
    if (apply && issueRecoveryAllowed) {
      recovery = { add: PIPELINE_LABELS.queued, dispatch: null, reason: 'complete interrupted Architect split publication' };
    }
    const entry = {
      type: 'issue', number, title: child.title,
      findings: [{ code: 'partial-architect-split-child', severity: 'repair' }],
      removals: [], recovery: null,
    };
    report.push(entry);
    if (recovery) pendingRepairs.push({
      number, expected: child, target: PIPELINE_LABELS.queued, entry, recovery,
    });
  }
}
}, () => ({ inspected: issues.length, findings: report.length, planned_repairs: pendingRepairs.length }));
await phase('issue-repairs', async () => {
  if (!apply) return;
  for (const repair of pendingRepairs) {
    await mutation('issue', repair.number, 'replace-state', () =>
      replaceStateLabels(repair.number, repair.expected, repair.target, 'issue'));
    repair.entry.recovery = repair.recovery;
  }
}, () => ({ completed_repairs: successfulMutations.filter(x => x.kind === 'issue').length,
  planned_repairs: pendingRepairs.length }));

let mergeGateRecoveryNeeded = false;
await phase('pr-recovery', async () => {
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
    await mutation('pr', pr.number, 'dispatch-' + owner, () =>
      tryDispatchWorkflow(workflow, { pr_number: String(pr.number) }));
    report.push({
      type: 'pr',
      number: pr.number,
      title: pr.title,
      findings: [{ code: 'orphaned-pr-pipeline', severity: 'repair' }],
      removals: [],
      recovery: {
        add: needsFix ? REVIEW_CHANGES_REQUESTED : 'unreviewed',
        dispatch: owner,
        reason: `restart stranded ${owner}`,
      },
    });
  }
  if (mergeGateRecoveryNeeded) {
    await mutation('pr', 0, 'dispatch-merge-gate', () =>
      tryDispatchWorkflow(workflowFile('mergeGate'), undefined));
  }
}
}, () => ({ prs_checked: prs.length, completed_mutations: successfulMutations.length }));
await phase('checkpoint-gc', async () => {
if (apply) {
  for (const number of checkpoints) {
    const issue = issuesByNumber.get(number);
    const decision = checkpointGcDecision(issue, { hasOpenPiPr: openPiPrIssues.has(number) });
    if (decision.remove) {
      await mutation('checkpoint', number, 'delete-ref', () => deleteRef(`heads/${checkpointBranch(number)}`));
      report.push({ type: 'checkpoint', number, title: decision.reason, findings: [{ code: 'checkpoint-gc', severity: 'repair' }], removals: [], recovery: null });
    }
  }
}
}, () => ({ checkpoints_checked: checkpoints.size, completed_mutations: successfulMutations.length }));
await phase('summary', async () => {
console.log(`Pipeline reconciler: ${report.length} object(s) need attention; mode=${apply ? 'apply-safe-repairs' : 'audit'}; automation=${automationMode}; issue-recovery=${issueRecoveryAllowed ? 'enabled' : 'deferred'}; pr-recovery=${prRecoveryAllowed ? 'enabled' : 'deferred'}`);
for (const item of report.slice(0, 50)) {
  console.log(`${item.type.toUpperCase()} #${item.number}`);
  for (const finding of item.findings) console.log(`  - ${finding.severity}: ${finding.code}`);
  if (apply && item.removals.length) console.log(`  repaired: removed ${item.removals.join(', ')}`);
  if (item.recovery) console.log(`  recovery: ${item.recovery.add}${item.recovery.dispatch ? ` + ${item.recovery.dispatch}` : ''} (${item.recovery.reason})`);
}
if (report.length > 50) console.log(`... ${report.length - 50} additional finding(s) omitted; totals above are authoritative`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const fs = await import('node:fs');
  const lines = ['## Pipeline reconciliation', '', `Mode: **${apply ? 'safe repair' : 'audit'}** · Findings: **${report.length}**`, ''];
  for (const item of report.slice(0, 50)) lines.push(`- **${item.type} #${item.number}** — ${item.findings.map(x => x.code).join(', ')}${item.removals.length ? `; safe removals: ${item.removals.join(', ')}` : ''}`);
  if (report.length > 50) lines.push(`... ${report.length - 50} additional finding(s) omitted.`);
  if (!report.length) lines.push('No inconsistent pipeline state found.');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
});
}
try {
  await reconcile();
  emit('complete', { status: 'ok', completed_mutations: successfulMutations.length });
} catch (error) {
  emit('failed', {
    status: 'failed', cause: errorCategory(error),
    completed_mutations: successfulMutations.length,
    recently_completed: successfulMutations.slice(-8),
    pending_requests: [...pending.values()].slice(0, 12).map(requestFields),
    ...(currentMutation ? { mutation: currentMutation } : {}),
  }, true);
  controller.abort();
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer);
  clearInterval(heartbeatTimer);
}

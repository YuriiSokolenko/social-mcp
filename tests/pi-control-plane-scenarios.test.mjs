import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inspectIssueState, inspectPrState, safeRemovals } from '../scripts/pi-state-machine.mjs';
import { recoveryForIssue, recoveryForPr, checkpointGcDecision } from '../scripts/pi-recovery-policy.mjs';

const labels = (...names) => names.map(name => ({ name }));
test('control plane: dead implementer with checkpoint is released and resumed', () => {
  const issue = { state:'open', labels:labels('pi:running') };
  const findings = inspectIssueState(issue, { hasLiveImplementer:false, hasCheckpoint:true });
  assert.deepEqual(safeRemovals(findings), ['pi:running']);
  assert.equal(recoveryForIssue(issue, { hasCheckpoint:true }).add, 'pi:ready');
  assert.equal(checkpointGcDecision(issue).remove, false);
});

test('control plane: published PR wins over restarting a dead implementer', () => {
  const issue = { state:'open', labels:labels('pi:running') };
  const recovery = recoveryForIssue(issue, { hasOpenPiPr:true, hasCheckpoint:true });
  assert.equal(recovery.add, 'pi:mr-created');
  assert.equal(recovery.dispatch, null);
});

test('control plane: dead reviewer is released and review is restarted', () => {
  const pr = { state:'open', labels:labels('review:running') };
  assert.deepEqual(safeRemovals(inspectPrState(pr, { hasLiveReviewer:false })), ['review:running']);
  assert.equal(recoveryForPr(pr).add, 'review:ready');
});

test('control plane: completed issue makes checkpoint garbage collectable', () => {
  assert.equal(checkpointGcDecision({ state:'closed', state_reason:'completed', labels:[] }).remove, true);
});


test('reconciler defers recovery dispatch outside RUNNING mode', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /automationMode === 'RUNNING'/);
  assert.match(source, /recoveryDispatchAllowed/);
  assert.match(source, /recovery\.dispatch === 'implementer' && recoveryDispatchAllowed/);
  assert.match(source, /recovery\.dispatch === 'reviewer' && recoveryDispatchAllowed/);
  assert.match(source, /apply && recoveryDispatchAllowed/);
  assert.match(source, /repair recovery deferred until RUNNING/);
  const workflow = fs.readFileSync('.github/workflows/pi-reconcile.yml', 'utf8');
  assert.match(workflow, /PI_AUTOMATION_MODE:/);
});


test('RUNNING control wakes both dispatcher and reconciler', () => {
  const workflow = fs.readFileSync('.github/workflows/pi-automation-control.yml', 'utf8');
  assert.match(workflow, /pi-dispatcher\.yml\/dispatches/);
  assert.match(workflow, /pi-reconcile\.yml\/dispatches/);
});


test('reconciler keeps recovery retryable when workflow dispatch fails', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /async function tryDispatchWorkflow/);
  assert.match(source, /pi:ready retained for retry/);
  assert.match(source, /review:ready retained for retry/);
  assert.match(source, /Recovery dispatch failed/);
});


test('reconciler retries stranded ready implementation and review states', () => {
  const source = fs.readFileSync('scripts/pi-reconcile.mjs', 'utf8');
  assert.match(source, /retryReadyImplementer/);
  assert.match(source, /wake serialized dispatcher for ready implementation/);
  assert.match(source, /tryDispatchWorkflow\('pi-dispatcher\.yml'/);
  assert.match(source, /retryReadyReviewer/);
  assert.match(source, /resume ready review/);
});


test('agent concurrency preserves active work and duplicate runs have idempotency guards', () => {
  for (const path of ['.github/workflows/pi-issue-agent.yml', '.github/workflows/pi-pr-review.yml', '.github/workflows/pi-pr-fix.yml']) {
    const workflow = fs.readFileSync(path, 'utf8');
    assert.match(workflow, /cancel-in-progress: false/);
  }
  const review = fs.readFileSync('.github/workflows/pi-pr-review.yml', 'utf8');
  assert.match(review, /social-mcp\/pi-review/);
  assert.match(review, /already has final state/);
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /review:changes-requested/);
  assert.match(repair, /duplicate dispatch exits without model work/);
});


test('long-running checkpoints use explicit compare-and-swap leases', () => {
  const implementer = fs.readFileSync('.github/workflows/pi-issue-agent.yml', 'utf8');
  assert.match(implementer, /PI_CHECKPOINT_EXPECTED/);
  assert.match(implementer, /--force-with-lease="refs\/heads\/pi\/issue-\$\{ISSUE\}-checkpoint:\$\{PI_CHECKPOINT_EXPECTED\}"/);
  const repair = fs.readFileSync('.github/workflows/pi-pr-fix.yml', 'utf8');
  assert.match(repair, /REPAIR_CHECKPOINT_EXPECTED/);
  assert.match(repair, /--force-with-lease="\$\{CHECKPOINT_REF\}:\$\{REPAIR_CHECKPOINT_EXPECTED\}"/);
});

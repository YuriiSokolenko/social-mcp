import test from 'node:test';
import assert from 'node:assert/strict';
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

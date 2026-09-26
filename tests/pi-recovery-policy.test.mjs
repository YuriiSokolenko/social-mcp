import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointGcDecision, recoveryForIssue, recoveryForPr } from '../scripts/pi-recovery-policy.mjs';

const issue = (state, labels, state_reason) => ({ state, state_reason, labels: labels.map(name => ({ name })) });

test('orphaned implementation with checkpoint resumes through pi:ready', () => {
  assert.deepEqual(recoveryForIssue(issue('open', ['pi:running']), { hasCheckpoint: true }), {
    add: 'pi:ready', dispatch: 'implementer', reason: 'resume saved checkpoint',
  });
});

test('orphaned implementation without checkpoint restarts through pi:ready', () => {
  assert.deepEqual(recoveryForIssue(issue('open', ['pi:running'])), {
    add: 'pi:ready', dispatch: 'implementer', reason: 'restart implementation',
  });
});

test('existing implementation PR recovers to mr-created without duplicate implementer', () => {
  assert.deepEqual(recoveryForIssue(issue('open', ['pi:running']), { hasOpenPiPr: true }), {
    add: 'pi:mr-created', dispatch: null, reason: 'open implementation PR exists',
  });
});

test('orphaned review returns to review-ready and restarts reviewer', () => {
  assert.deepEqual(recoveryForPr({ state: 'open', labels: [{ name: 'review:running' }] }), {
    add: 'review:ready', dispatch: 'reviewer', reason: 'restart semantic review for current PR head',
  });
});

test('checkpoint GC only removes proven published or completed work', () => {
  assert.equal(checkpointGcDecision(issue('open', ['pi:running'])).remove, false);
  assert.equal(checkpointGcDecision(issue('open', ['pi:mr-created'])).remove, false);
  assert.equal(checkpointGcDecision(issue('closed', [], 'completed')).remove, true);
  assert.equal(checkpointGcDecision(issue('closed', [], 'not_planned')).remove, false);
  assert.equal(checkpointGcDecision(issue('closed', [], 'completed'), { hasOpenPiPr: true }).remove, false);
});

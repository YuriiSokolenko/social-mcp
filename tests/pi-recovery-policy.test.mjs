import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointGcDecision, issueRecoveryTarget } from '../scripts/pi-common/recovery-policy.mjs';

const issue = (state, labels, state_reason) => ({ state, state_reason, labels: labels.map(name => ({ name })) });

test('lost issue ownership returns to Dispatcher only while RUNNING', () => {
  const current = issue('open', ['pi:running']);
  assert.equal(issueRecoveryTarget(current, { automationMode: 'RUNNING' }), 'dispatcher:ready');
  assert.equal(issueRecoveryTarget(current, { automationMode: 'DRAINING' }), null);
  assert.equal(issueRecoveryTarget(current, { automationMode: 'PAUSED' }), null);
});

test('terminal issue ownership is preserved instead of being re-queued', () => {
  assert.equal(
    issueRecoveryTarget(issue('open', ['pi:needs-human', 'pi:running']), { automationMode: 'RUNNING' }),
    'pi:needs-human',
  );
  assert.equal(
    issueRecoveryTarget(issue('open', ['pi:blocked', 'pi:ready']), { automationMode: 'RUNNING' }),
    'pi:blocked',
  );
});

test('existing implementation PR remains the durable owner', () => {
  const current = issue('open', ['pi:running']);
  assert.equal(issueRecoveryTarget(current, { hasOpenPiPr: true, automationMode: 'RUNNING' }), 'pi:mr-created');
  assert.equal(issueRecoveryTarget(current, { hasOpenPiPr: true, automationMode: 'DRAINING' }), 'pi:mr-created');
});

test('closed or missing issues do not receive recovery ownership', () => {
  assert.equal(issueRecoveryTarget(issue('closed', []), { automationMode: 'RUNNING' }), null);
  assert.equal(issueRecoveryTarget(null, { automationMode: 'RUNNING' }), null);
});

test('checkpoint GC only removes completed work with no open implementation PR', () => {
  assert.equal(checkpointGcDecision(issue('open', ['pi:running'])).remove, false);
  assert.equal(checkpointGcDecision(issue('open', ['pi:mr-created'])).remove, false);
  assert.equal(checkpointGcDecision(issue('closed', [], 'completed')).remove, true);
  assert.equal(checkpointGcDecision(issue('closed', [], 'not_planned')).remove, false);
  assert.equal(checkpointGcDecision(issue('closed', [], 'completed'), { hasOpenPiPr: true }).remove, false);
});

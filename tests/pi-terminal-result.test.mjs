import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalResult, registerSubmitNudge } from '../scripts/pi-common/terminal-result.mjs';

test('terminalResult returns one terminating text result with details intact', () => {
  const details = { ok: true };
  assert.deepEqual(terminalResult('done', details), {
    content: [{ type: 'text', text: 'done' }], details, terminate: true,
  });
});

test('submit nudge fires at most once while result is missing', () => {
  let handler;
  const pi = { on(event, fn) { assert.equal(event, 'agent_before_settle'); handler = fn; } };
  registerSubmitNudge(pi, { isSubmitted: () => false, customType: 'result-nudge', content: 'submit now' });
  assert.deepEqual(handler(), { continue: true, entries: [{ type: 'custom_message', customType: 'result-nudge', content: 'submit now', display: true }] });
  assert.equal(handler(), undefined);
});

test('submit nudge stays silent after submission', () => {
  let handler;
  const pi = { on(_event, fn) { handler = fn; } };
  registerSubmitNudge(pi, { isSubmitted: () => true, customType: 'x', content: 'unused' });
  assert.equal(handler(), undefined);
});

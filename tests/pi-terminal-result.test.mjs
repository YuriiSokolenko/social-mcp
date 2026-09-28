import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { terminalResult, registerSubmitNudge } from '../scripts/pi-common/terminal-result.mjs';

test('terminalResult returns one terminating text result with details intact', () => {
  const details = { ok: true };
  assert.deepEqual(terminalResult('done', details), {
    content: [{ type: 'text', text: 'done' }], details, terminate: true,
  });
});

test('terminalResult records the shared terminal marker when configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-'));
  const marker = path.join(dir, 'submitted');
  const previous = process.env.PI_TERMINAL_RESULT_FILE;
  process.env.PI_TERMINAL_RESULT_FILE = marker;
  try {
    terminalResult('done', undefined);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'submitted\n');
  } finally {
    if (previous === undefined) delete process.env.PI_TERMINAL_RESULT_FILE;
    else process.env.PI_TERMINAL_RESULT_FILE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

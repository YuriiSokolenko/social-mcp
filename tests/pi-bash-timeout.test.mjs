import test from 'node:test';
import assert from 'node:assert/strict';
import { bashTimeout, registerTimedBash } from '../scripts/pi-bash-timeout-policy.mjs';

test('every bash call receives a timeout that cannot exceed the role limit', async () => {
  const received = [];
  const original = {
    label: 'bash', description: 'run a shell command', parameters: { type: 'object' },
    async execute(...args) { received.push(args); return { content: [] }; },
  };
  const pi = { registerTool(tool) { this.tool = tool; } };
  registerTimedBash(pi, () => original, 600, '/tmp');
  for (const timeout of [undefined, 30, 9999, 0]) {
    await pi.tool.execute('call', { command: 'echo ok', timeout }, undefined, undefined);
  }
  assert.deepEqual(received.map(call => call[1].timeout), [600, 30, 600, 600]);
  assert.ok(received.every(call => call[1].command === 'echo ok'));
});

test('invalid configuration fails before Pi starts', () => {
  for (const value of [NaN, 0, -5, 3.4]) {
    assert.throws(() => bashTimeout(undefined, value));
  }
});

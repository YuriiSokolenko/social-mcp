import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, toolCallSignature, turnBudget, repeatLimit } from '../scripts/pi-loop-guard-policy.mjs';

test('blocks tool calls once the turn budget is reached', () => {
  const guard = new LoopGuard({ turnLimit: 3, repeatThreshold: 10 });
  guard.onTurnStart(0);
  assert.equal(guard.checkToolCall('bash', { command: 'ls' }), undefined);
  guard.onTurnStart(2);
  assert.equal(guard.checkToolCall('bash', { command: 'ls' }), undefined);
  guard.onTurnStart(3);
  const result = guard.checkToolCall('bash', { command: 'ls' });
  assert.equal(result.block, true);
  assert.match(result.reason, /Turn budget exceeded \(3 turns\)/);
});

test('blocks a call repeated past the threshold, independent of turn budget', () => {
  const guard = new LoopGuard({ turnLimit: 1000, repeatThreshold: 2 });
  guard.onTurnStart(0);
  const command = { command: 'git log --all --oneline | grep -iE "issue.*9"' };
  assert.equal(guard.checkToolCall('bash', command), undefined);
  assert.equal(guard.checkToolCall('bash', command), undefined);
  const result = guard.checkToolCall('bash', command);
  assert.equal(result.block, true);
  assert.match(result.reason, /already ran this exact bash call 2 times/);
});

test('different arguments do not count toward the same repeat total', () => {
  const guard = new LoopGuard({ turnLimit: 1000, repeatThreshold: 1 });
  guard.onTurnStart(0);
  assert.equal(guard.checkToolCall('bash', { command: 'git status' }), undefined);
  assert.equal(guard.checkToolCall('bash', { command: 'git log' }), undefined);
  assert.equal(guard.checkToolCall('read', { path: 'README.md' }), undefined);
});

test('whitespace-only differences still count as the same call', () => {
  assert.equal(
    toolCallSignature('bash', { command: 'echo  ok' }),
    toolCallSignature('bash', { command: 'echo ok' }),
  );
});

test('invalid configuration fails before Pi starts', () => {
  for (const value of [NaN, 0, -5, 3.4]) {
    assert.throws(() => turnBudget(value));
    assert.throws(() => repeatLimit(value));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, complexityProfile, toolCallSignature, turnBudget, repeatLimit } from '../scripts/pi-common/loop-guard-policy.mjs';

test('legacy guard blocks tool calls once the configured turn budget is reached', () => {
  const guard = new LoopGuard({ turnLimit: 3, repeatThreshold: 10 });
  guard.onTurnStart(2);
  assert.equal(guard.checkToolCall('bash', { command: 'ls' }), undefined);
  guard.onTurnStart(3);
  assert.equal(guard.checkToolCall('bash', { command: 'ls' }).block, true);
});

test('implementer must declare complexity before implementation tools', () => {
  const guard = new LoopGuard({ repeatThreshold: 3, requireComplexity: true });
  assert.equal(guard.checkToolCall('declare_task_complexity', { complexity: 'trivial' }), undefined);
  const blocked = guard.checkToolCall('write', { path: 'x' });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Declare task complexity first/);
});

test('trivial profile warns early and hard-blocks exploration while preserving submit_result', () => {
  const guard = new LoopGuard({ repeatThreshold: 3, requireComplexity: true });
  const profile = complexityProfile('trivial');
  assert.deepEqual(profile, { softTurns: 3, hardTurns: 5, toolCalls: 8 });

  // Turns before declaration do not consume the selected profile.
  guard.onTurnStart(9);
  guard.setComplexity('trivial');
  guard.onTurnStart(11);
  assert.equal(guard.takeSoftWarning(), undefined);
  guard.onTurnStart(12);
  assert.match(guard.takeSoftWarning(), /nearing its limit/);
  assert.equal(guard.takeSoftWarning(), undefined);

  guard.onTurnStart(14);
  const blocked = guard.checkToolCall('read', { path: 'README.md' });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Exploration budget exhausted/);
  assert.equal(guard.checkToolCall('write', { path: 'result.txt' }), undefined);
  assert.equal(guard.checkToolCall('edit', { path: 'result.txt' }), undefined);
  assert.equal(guard.checkToolCall('submit_result', {}), undefined);
});

test('trivial profile hard-blocks excessive exploration while preserving completion tools', () => {
  const guard = new LoopGuard({ repeatThreshold: 20, requireComplexity: true });
  guard.setComplexity('trivial');
  guard.onTurnStart(1);
  for (let i = 0; i < complexityProfile('trivial').toolCalls; i += 1) {
    assert.equal(guard.checkToolCall('read', { path: `file-${i}` }), undefined);
  }
  assert.match(guard.checkToolCall('read', { path: 'one-too-many' }).reason, /Tool-call budget exceeded/);
});

test('complexity can only be declared once', () => {
  const guard = new LoopGuard({ repeatThreshold: 3, requireComplexity: true });
  guard.setComplexity('normal');
  assert.throws(() => guard.setComplexity('trivial'), /already declared/);
});

test('blocks a call repeated past the threshold, independent of turn budget', () => {
  const guard = new LoopGuard({ turnLimit: 1000, repeatThreshold: 2 });
  guard.onTurnStart(0);
  const command = { command: 'git log --all --oneline | grep issue' };
  assert.equal(guard.checkToolCall('bash', command), undefined);
  assert.equal(guard.checkToolCall('bash', command), undefined);
  assert.match(guard.checkToolCall('bash', command).reason, /already ran this exact bash call 2 times/);
});

test('whitespace-only differences still count as the same call', () => {
  assert.equal(toolCallSignature('bash', { command: 'echo  ok' }), toolCallSignature('bash', { command: 'echo ok' }));
});

test('invalid configuration fails before Pi starts', () => {
  for (const value of [NaN, 0, -5, 3.4]) {
    assert.throws(() => turnBudget(value));
    assert.throws(() => repeatLimit(value));
  }
  assert.throws(() => complexityProfile('tiny'), /Unknown task complexity/);
});

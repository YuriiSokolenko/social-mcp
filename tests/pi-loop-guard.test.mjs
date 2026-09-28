import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, toolCallSignature, turnBudget, repeatLimit, validateComplexity } from '../scripts/pi-common/loop-guard-policy.mjs';
import { RESPONSE_BUDGETS, responseBudget, withResponseBudget } from '../scripts/pi-common/response-budget-policy.mjs';

test('global turn ceiling is independent of task complexity', () => {
  const guard = new LoopGuard({ turnLimit: 3, repeatThreshold: 10, requireComplexity: true });
  guard.setComplexity('trivial');
  assert.equal(guard.checkToolCall('edit', { path: 'a' }), undefined);
  guard.onTurnStart(2);
  assert.equal(guard.checkToolCall('read', { path: 'b' }), undefined);
  guard.onTurnStart(3);
  assert.equal(guard.checkToolCall('read', { path: 'c' }).block, true);
});

test('required operating contract is the first tool read when configured', () => {
  const guard = new LoopGuard({
    repeatThreshold: 3,
    requiredFirstReadPath: 'agents/triage/AGENTS.md',
  });
  assert.equal(guard.checkToolCall('read', { path: '/work/pi-triage-context.json' }).block, true);
  assert.equal(guard.checkToolCall('bash', { command: 'cat context.json' }).block, true);
  assert.equal(guard.checkToolCall('read', { path: '/work/agents/triage/AGENTS.md' }), undefined);
  assert.equal(guard.checkToolCall('read', { path: '/work/pi-triage-context.json' }), undefined);
});

test('bounded orientation is allowed before required complexity declaration', () => {
  const guard = new LoopGuard({
    repeatThreshold: 3,
    requireComplexity: true,
    preComplexityAllowedTools: ['read', 'bash'],
    preComplexityTurnLimit: 8,
  });
  assert.equal(guard.checkToolCall('read', { path: '/work/agents/implementer/AGENTS.md' }), undefined);
  assert.equal(guard.checkToolCall('read', { path: '/work/src/social_mcp/storage/sqlite.py' }), undefined);
  assert.equal(guard.checkToolCall('bash', { command: 'ls' }), undefined);
  assert.equal(guard.checkToolCall('edit', { path: '/work/src/social_mcp/storage/sqlite.py' }).block, true);
  assert.equal(guard.checkToolCall('write', { path: '/work/new.py' }).block, true);
  assert.equal(guard.checkToolCall('submit_result', {}).block, true);
  guard.setComplexity('trivial');
  assert.equal(guard.checkToolCall('edit', { path: '/work/src/social_mcp/storage/sqlite.py' }), undefined);
  assert.equal(guard.checkToolCall('read', { path: '/work/src/social_mcp/storage/sqlite.py' }), undefined);
});

test('pre-complexity orientation stops after the configured turn budget', () => {
  const guard = new LoopGuard({
    repeatThreshold: 10,
    requireComplexity: true,
    preComplexityAllowedTools: ['read', 'bash'],
    preComplexityTurnLimit: 2,
  });
  guard.onTurnStart(0);
  assert.equal(guard.checkToolCall('read', { path: 'agents/implementer/AGENTS.md' }), undefined);
  guard.onTurnStart(1);
  assert.equal(guard.checkToolCall('bash', { command: 'grep target src/a.py' }), undefined);
  guard.onTurnStart(2);
  const blocked = guard.checkToolCall('read', { path: 'src/b.py' });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /call declare_task_complexity now/);
  assert.equal(guard.checkToolCall('declare_task_complexity', { complexity: 'normal' }), undefined);
});

test('required complexity makes the first post-plan tool call an edit', () => {
  const guard = new LoopGuard({
    turnLimit: 100,
    repeatThreshold: 3,
    requireComplexity: true,
    preComplexityAllowedTools: ['read', 'bash'],
  });
  guard.setComplexity('normal');
  for (const [toolName, input] of [
    ['read', { path: 'src/a.py' }],
    ['bash', { command: 'grep -n target src/b.py' }],
    ['set_response_budget', { budget: 'normal' }],
  ]) {
    const blocked = guard.checkToolCall(toolName, input);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /next tool call must make the first repository edit/);
  }
  assert.equal(guard.checkToolCall('edit', { path: 'src/a.py' }), undefined);
  assert.equal(guard.checkToolCall('read', { path: 'src/c.py' }), undefined);
});

test('complexity can escalate but cannot downgrade', () => {
  const guard = new LoopGuard({ repeatThreshold: 3, requireComplexity: true });
  assert.equal(guard.setComplexity('trivial').complexity, 'trivial');
  assert.equal(guard.setComplexity('normal').complexity, 'normal');
  assert.equal(guard.setComplexity('complex').complexity, 'complex');
  assert.throws(() => guard.setComplexity('normal'), /cannot be downgraded/);
});

test('complexity does not impose quotas after implementation starts', () => {
  const guard = new LoopGuard({ turnLimit: 100, repeatThreshold: 3, requireComplexity: true });
  guard.setComplexity('trivial');
  guard.onTurnStart(1);
  assert.equal(guard.checkToolCall('edit', { path: 'file-0' }), undefined);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(guard.checkToolCall('read', { path: `file-${i}` }), undefined);
  }
});

test('blocks an exact call repeated past the threshold', () => {
  const guard = new LoopGuard({ turnLimit: 100, repeatThreshold: 2 });
  guard.onTurnStart(0);
  const command = { command: 'git log --all --oneline | grep issue' };
  assert.equal(guard.checkToolCall('bash', command), undefined);
  assert.equal(guard.checkToolCall('bash', command), undefined);
  assert.match(guard.checkToolCall('bash', command).reason, /already ran this exact bash call 2 times/);
});

test('whitespace-only differences still count as the same call', () => {
  assert.equal(toolCallSignature('bash', { command: 'echo  ok' }), toolCallSignature('bash', { command: 'echo ok' }));
});

test('invalid configuration and complexity fail early', () => {
  for (const value of [NaN, 0, -5, 3.4]) {
    assert.throws(() => turnBudget(value));
    assert.throws(() => repeatLimit(value));
  }
  assert.throws(() => validateComplexity('tiny'), /Unknown task complexity/);
});


test('response budgets are intentionally capped at 2k, 4k, and 8k', () => {
  assert.deepEqual(RESPONSE_BUDGETS, { short: 2048, normal: 4096, deep: 8192 });
  assert.equal(responseBudget('short'), 2048);
  assert.equal(responseBudget('normal'), 4096);
  assert.equal(responseBudget('deep'), 8192);
  assert.throws(() => responseBudget('unbounded'), /Unknown response budget/);
});

test('response budget changes only maxTokens on the active model definition', () => {
  const model = { provider: 'hp-laguna', id: 'qwen3.8-flash-next', contextWindow: 262144, maxTokens: 32000 };
  const budgeted = withResponseBudget(model, 'normal');
  assert.deepEqual(budgeted, { ...model, maxTokens: 4096 });
  assert.equal(model.maxTokens, 32000);
});

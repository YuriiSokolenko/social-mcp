import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProgressController,
  RESPONSE_BUDGETS,
  nextResponseBudgetLevel,
  toolCallSignature,
} from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const controller = (overrides = {}, env = {}) => new ProgressController({
  maxTurns: 100,
  repeatThreshold: 3,
  requireComplexity: false,
  ...overrides,
}, env);

test('shared response budgets stay capped at 2k, 4k, and 8k', () => {
  assert.deepEqual(RESPONSE_BUDGETS, { short: 2048, normal: 4096, deep: 8192 });
  assert.equal(nextResponseBudgetLevel('short', 2048), 'short');
  assert.equal(nextResponseBudgetLevel('short', 2048, RESPONSE_BUDGETS, { madeProgress: true }), 'normal');
  assert.equal(nextResponseBudgetLevel('normal', 4096, RESPONSE_BUDGETS, { madeProgress: true }), 'deep');
  assert.equal(nextResponseBudgetLevel('deep', 8192, RESPONSE_BUDGETS, { madeProgress: true }), 'short');
});

test('required operating contract is the first tool read', () => {
  const state = controller({ requiredFirstReadPath: 'agents/triage/AGENTS.md' });
  assert.equal(state.checkToolCall('bash', { command: 'cat context.json' }).block, true);
  assert.equal(state.checkToolCall('read', { path: '/work/agents/triage/AGENTS.md' }), undefined);
  assert.equal(state.checkToolCall('bash', { command: 'cat context.json' }), undefined);
});

test('complexity is a bounded planning declaration, not an execution quota', () => {
  const state = controller({
    requireComplexity: true,
    preComplexityAllowedTools: ['read', 'bash'],
    preComplexityTurnLimit: 2,
  });
  state.onTurnStart(0);
  assert.equal(state.checkToolCall('read', { path: 'a' }), undefined);
  assert.equal(state.checkToolCall('edit', { path: 'a' }).block, true);
  state.onTurnStart(1);
  assert.equal(state.checkToolCall('bash', { command: 'grep target a' }), undefined);
  state.onTurnStart(2);
  assert.match(state.checkToolCall('read', { path: 'b' }).reason, /declare_task_complexity/);
  state.setComplexity('normal');
  assert.equal(state.checkToolCall('read', { path: 'b' }), undefined);
  assert.equal(state.checkToolCall('edit', { path: 'b' }), undefined);
});

test('complexity can escalate but cannot downgrade', () => {
  const state = controller({ requireComplexity: true });
  assert.equal(state.setComplexity('trivial').complexity, 'trivial');
  assert.equal(state.setComplexity('normal').complexity, 'normal');
  assert.equal(state.setComplexity('complex').complexity, 'complex');
  assert.throws(() => state.setComplexity('normal'), /cannot be downgraded/);
});

test('turn accounting remains monotonic after Pi compaction resets turnIndex', () => {
  const state = controller({ maxTurns: 3 });
  state.onTurnStart(0);
  state.onTurnStart(1);
  state.onTurnStart(0);
  state.onTurnStart(1);
  assert.equal(state.absoluteTurn, 3);
  assert.equal(state.checkToolCall('read', { path: 'x' }).block, true);
  assert.equal(state.checkToolCall('edit', { path: 'x' }), undefined);
  assert.equal(state.checkToolCall('submit_result', {}), undefined);
});

test('repeat protection is consecutive and nested arguments are canonicalized', () => {
  const state = controller({ repeatThreshold: 2 });
  const same = { outer: { b: 2, a: 1 } };
  assert.equal(toolCallSignature('x', same), toolCallSignature('x', { outer: { a: 1, b: 2 } }));
  assert.notEqual(toolCallSignature('x', same), toolCallSignature('x', { outer: { a: 1, b: 3 } }));
  assert.equal(state.checkToolCall('bash', { command: 'git  status' }), undefined);
  assert.equal(state.checkToolCall('bash', { command: 'git status' }), undefined);
  assert.match(state.checkToolCall('bash', { command: 'git status' }).reason, /already ran this exact bash call 2 times/);
  assert.equal(state.checkToolCall('read', { path: 'a' }), undefined);
  assert.equal(state.checkToolCall('bash', { command: 'git status' }), undefined);
});

test('reasoning-only ceiling hits do not earn larger budgets', () => {
  const state = controller();
  state.onTurnStart(0);
  assert.equal(state.afterTurn(2048).level, 'short');
  state.onTurnStart(1);
  state.onToolExecutionEnd('edit', false);
  assert.equal(state.afterTurn(2048).level, 'normal');
  state.onTurnStart(2);
  assert.equal(state.afterTurn(100).level, 'short');
});

test('explicit response budget applies to one next response', () => {
  const state = controller();
  state.onTurnStart(0);
  assert.equal(state.setBudget('deep'), 8192);
  const afterRequest = state.afterTurn(50);
  assert.equal(afterRequest.explicit, true);
  assert.equal(afterRequest.level, 'deep');
  state.onTurnStart(1);
  assert.equal(state.afterTurn(50).level, 'short');
});

test('stage configuration centralizes per-agent runtime policy', () => {
  assert.equal(stageConfig('dispatcher').maxTurns, 30);
  assert.equal(stageConfig('triage').fixedResponseMaxTokens, 1000);
  for (const name of ['implementer', 'reviewer', 'repair']) {
    assert.equal(stageConfig(name).requireComplexity, true);
    assert.deepEqual(stageConfig(name).preComplexityAllowedTools, ['read', 'bash']);
  }
  for (const name of ['architect', 'dispatcher', 'triage', 'reviewer', 'repair', 'implementer']) {
    assert.match(stageConfig(name).resultTool, /-result-tool\.mjs$/);
    assert.match(stageConfig(name).requiredFirstReadPath, /AGENTS\.md$/);
  }
});

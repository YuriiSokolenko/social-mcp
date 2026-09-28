import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProgressController,
  RESPONSE_BUDGETS,
  nextResponseBudgetLevel,
  toolCallSignature,
} from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig, stagePrompt } from '../scripts/pi-common/stage-config.mjs';

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

test('pre-complexity turn budget starts after the required contract read', () => {
  const state = controller({
    requiredFirstReadPath: 'agents/implementer/AGENTS.md',
    requireComplexity: true,
    preComplexityAllowedTools: ['subagent'],
    preComplexityTurnLimit: 2,
  });
  for (let turn = 0; turn < 6; turn += 1) {
    state.onTurnStart(turn);
    assert.equal(state.checkToolCall('bash', { command: 'pwd' }).block, true);
  }
  assert.equal(state.checkToolCall('read', { path: 'agents/implementer/AGENTS.md' }), undefined);
  state.onTurnStart(6);
  assert.equal(state.checkToolCall('subagent', { task: 'inspect target' }), undefined);
  state.onTurnStart(7);
  assert.match(state.checkToolCall('subagent', { task: 'inspect another target' }).reason, /declare_task_complexity/);
});

test('configured repository tools must be delegated after startup', () => {
  const state = controller({
    requiredFirstReadPath: 'agents/implementer/AGENTS.md',
    requireComplexity: true,
    preComplexityAllowedTools: [],
    delegatedTools: ['read', 'bash', 'grep', 'find', 'ls'],
    delegationTool: 'subagent',
  });
  state.onTurnStart(0);
  assert.equal(state.checkToolCall('read', { path: 'agents/implementer/AGENTS.md' }), undefined);
  state.setComplexity('trivial');
  for (const tool of ['read', 'bash', 'grep', 'find', 'ls']) {
    assert.match(state.checkToolCall(tool, {}).reason, /subagent/);
  }
  assert.equal(state.checkToolCall('subagent', { task: 'find a file' }), undefined);
  assert.equal(state.checkToolCall('edit', { path: 'README.md' }), undefined);
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
  for (const name of ['implementer', 'reviewer', 'repair']) assert.equal(stageConfig(name).requireComplexity, true);
  for (const name of ['reviewer', 'repair']) assert.deepEqual(stageConfig(name).preComplexityAllowedTools, ['read', 'bash']);
  assert.deepEqual(stageConfig('implementer').preComplexityAllowedTools, []);
  assert.deepEqual(stageConfig('implementer').delegatedTools, ['read', 'bash', 'grep', 'find', 'ls']);
  assert.equal(stageConfig('implementer').delegationTool, 'subagent');
  for (const name of ['architect', 'dispatcher', 'triage', 'reviewer', 'repair', 'implementer']) {
    assert.match(stageConfig(name).resultTool, /-result-tool\.mjs$/);
    assert.match(stageConfig(name).requiredFirstReadPath, /AGENTS\.md$/);
  }
});


test('stage configuration owns every model prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-stage-prompt-'));
  const issueContext = path.join(dir, 'issue.json');
  fs.writeFileSync(issueContext, JSON.stringify({ title: 'Example issue', body: 'Acceptance criteria' }));
  const env = {
    RUNNER_TEMP: dir,
    ISSUE: '42',
    PI_ISSUE: '42',
    PR: '7',
    PI_ISSUE_CONTEXT: issueContext,
    ISSUE_CONTEXT: issueContext,
  };
  try {
    for (const name of ['architect', 'dispatcher', 'triage', 'reviewer', 'repair', 'implementer']) {
      const prompt = stagePrompt(name, env);
      assert.equal(typeof prompt, 'string');
      assert.ok(prompt.includes(`agents/${name === 'repair' ? 'repair' : name}/AGENTS.md`));
      assert.match(prompt, /submit_(?:result|repair)/);
    }
    assert.match(stagePrompt('implementer', env), /Example issue[\s\S]*Acceptance criteria/);
    assert.match(stagePrompt('implementer', env), /subagents_enable[\s\S]*scout[\s\S]*run-ci/);
    assert.match(stagePrompt('dispatcher', env), /pi-dispatcher-context\.json/);
    assert.match(stagePrompt('triage', env), /pi-triage-context\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

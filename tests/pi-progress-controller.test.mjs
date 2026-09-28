import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ProgressController,
  RESPONSE_BUDGETS,
  isBoundedDirectBash,
  nextResponseBudgetLevel,
  toolCallSignature,
} from '../scripts/pi-common/progress-controller.mjs';
import { stageConfig, stagePrompt } from '../scripts/pi-common/stage-config.mjs';
import subagentResponseBudget from '../scripts/pi-subagent-response-budget.mjs';

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

test('scout child response budget mirrors the main response ceiling', async () => {
  const previous = process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
  let handler;
  let appliedModel;
  const pi = {
    on(name, callback) {
      if (name === 'session_start') handler = callback;
    },
    async setModel(model) {
      appliedModel = model;
      return true;
    },
  };
  try {
    subagentResponseBudget(pi);
    process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = '4096';
    await handler({}, { model: { provider: 'test', id: 'model', maxTokens: 32000 } });
    assert.equal(appliedModel.maxTokens, 4096);

    process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = '8192';
    await handler({}, { model: { provider: 'test', id: 'model', maxTokens: 4096 } });
    assert.equal(appliedModel.maxTokens, 4096);
  } finally {
    if (previous == null) delete process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS;
    else process.env.PI_SUBAGENT_RESPONSE_MAX_TOKENS = previous;
  }
});

test('implementer exposes one runtime-owned preparation action before repository work', () => {
  const state = controller({
    requireComplexity: true,
    preComplexityAllowedTools: ['prepare_implementation'],
  });
  state.onTurnStart(0);
  assert.equal(state.checkToolCall('prepare_implementation', {}), undefined);
  assert.match(state.checkToolCall('subagents_enable', {}).reason, /configured complexity action/);
  assert.match(state.checkToolCall('subagent', { agent: 'implementation-planner', async: false }).reason, /configured complexity action/);
  state.setComplexity('trivial');
  assert.equal(state.checkToolCall('subagent', { agent: 'scout', async: false }), undefined);
});

test('runtime-owned preparation delegates structured planner then classifier', () => {
  const runtime = fs.readFileSync('scripts/pi-agent-runtime.mjs', 'utf8');
  const planner = fs.readFileSync('.pi/agents/implementation-planner.md', 'utf8');
  const settings = JSON.parse(fs.readFileSync('.pi/settings.json', 'utf8'));
  assert.match(runtime, /prompt-template:subagent:request/);
  assert.match(runtime, /prompt-template:subagent:response/);
  assert.match(runtime, /name: 'prepare_implementation'/);
  assert.match(runtime, /IMPLEMENTATION_PLAN_SCHEMA/);
  assert.match(runtime, /implementationPlannerMaxTokens \?\? 480/);
  assert.match(runtime, /runStructuredImplementationPlanner[\s\S]*runStructuredComplexityClassifier/);
  assert.match(runtime, /implementationPlannerMaxTokens \?\? 480[\s\S]*toolBudget: \{ hard: 3 \}/);
  assert.match(runtime, /complexityClassifierTimeoutMs \?\? 120000[\s\S]*toolBudget: \{ hard: 1 \}/);
  assert.match(runtime, /controller\.setComplexity\(classified\.complexity\)/);
  assert.match(planner, /inheritSkills: true/);
  assert.match(planner, /do not classify complexity/i);
  assert.deepEqual(settings.subagents.agentOverrides['implementation-planner'].subagentOnlyExtensions, ['./scripts/pi-subagent-response-budget.mjs']);
});

test('bounded local operations stay in main while exploration remains delegated', () => {
  const state = controller({
    delegatedTools: ['grep', 'find', 'ls'],
    delegationTool: 'subagent',
    directReadMaxLines: 200,
    directReadCalls: 1,
    boundedDirectBash: true,
  });
  state.onTurnStart(0);
  assert.equal(state.checkToolCall('read', { path: 'src/known.py', limit: 120 }), undefined);
  assert.match(state.checkToolCall('read', { path: 'src/second.py', limit: 120 }).reason, /read budget/);
  assert.match(state.checkToolCall('grep', { pattern: 'token' }).reason, /subagent/);
  assert.equal(state.checkToolCall('bash', { command: 'git diff -- src/known.py' }), undefined);
  assert.equal(state.checkToolCall('bash', { command: 'git diff --check -- src/known.py' }), undefined);
  assert.equal(state.checkToolCall('bash', { command: 'git status --short -- src/known.py' }), undefined);
  assert.match(state.checkToolCall('bash', { command: 'git diff' }).reason, /bounded git diff/);
  assert.match(state.checkToolCall('bash', { command: 'pytest -q tests/test_known.py' }).reason, /broader commands/);
  assert.match(state.checkToolCall('bash', { command: 'git diff -- src/known.py; cat secrets' }).reason, /bounded git diff/);
  assert.equal(isBoundedDirectBash('git diff --numstat -- src/known.py'), true);
  assert.equal(isBoundedDirectBash('git log --oneline'), false);
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
  assert.match(state.checkToolCall('subagent', { task: 'inspect another target' }).reason, /configured preparation\/classification action/);
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
  assert.match(state.checkToolCall('read', { path: 'b' }).reason, /configured preparation\/classification action/);
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
  assert.deepEqual(stageConfig('implementer').preComplexityAllowedTools, ['prepare_implementation']);
  assert.equal(stageConfig('implementer').implementationPlannerAgent, 'implementation-planner');
  assert.equal(stageConfig('implementer').implementationPlannerMaxTokens, 480);
  assert.equal(stageConfig('implementer').implementationPlannerTimeoutMs, 120000);
  assert.equal(stageConfig('implementer').complexityClassifierAgent, 'complexity-classifier');
  assert.equal(stageConfig('implementer').complexityClassifierTimeoutMs, 120000);
  assert.deepEqual(stageConfig('implementer').delegatedTools, ['grep', 'find', 'ls']);
  assert.equal(stageConfig('implementer').delegationTool, 'subagent');
  assert.equal(stageConfig('implementer').directReadMaxLines, 200);
  assert.equal(stageConfig('implementer').directReadCalls, 1);
  assert.equal(stageConfig('implementer').boundedDirectBash, true);
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
    assert.match(stagePrompt('implementer', env), /prepare_implementation[\s\S]*implementation-planner[\s\S]*complexity-classifier/);
    assert.match(stagePrompt('implementer', env), /Available delegated agents[\s\S]*scout[\s\S]*reviewer[\s\S]*oracle/);
    assert.match(stagePrompt('implementer', env), /do not call subagent\(action:"list"\)/i);
    assert.match(stagePrompt('implementer', env), /480 max output tokens/);
    assert.match(stagePrompt('implementer', env), /limit <= 200/);
    assert.match(stagePrompt('dispatcher', env), /pi-dispatcher-context\.json/);
    assert.match(stagePrompt('triage', env), /pi-triage-context\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

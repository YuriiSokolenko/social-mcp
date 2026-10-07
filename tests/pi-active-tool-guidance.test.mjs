import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ProgressController, actionRequiredToolNames, elevatedMutationTurnToolNames } from '../scripts/pi-common/progress-controller.mjs';
import { activeToolGuidance } from '../scripts/pi-common/session-state.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const ACTIVE = [
  'read',
  'repo_search',
  'indexed_repo_search',
  'bash',
  'run_check',
  'safe_edit',
  'write',
  'begin_coding_session',
  'rollback_last_mutation',
  'submit_result',
  'need_more_evidence',
  'request_large_mutation_budget',
];

function surface(state) {
  if (state.productiveProgressState() !== 'action_required') return [...ACTIVE];
  const cfg = stageConfig('implementer').productiveProgress;
  return actionRequiredToolNames(ACTIVE, {
    actionTools: cfg.actionTools,
    controlTools: cfg.controlTools,
    directTools: state.directActionToolNames(),
    blockerTool: cfg.blockerTool,
    verificationTools: state.verificationPermitted() ? [cfg.verificationTool] : [],
  });
}

function preparedController(evidenceBudget = 1) {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.onTurnStart(0);
  state.applyPreparedImplementation({ status: 'prepared', plan: ['plan'], complexity: 'nontrivial', evidenceBudget, largeMutation: false, reason: 'test' });
  return state;
}

test('activeToolGuidance names only the authoritative current surface', () => {
  const guidance = activeToolGuidance(['safe_edit', 'submit_result', 'safe_edit']);
  assert.match(guidance, /safe_edit, submit_result/);
  assert.doesNotMatch(guidance, /read|repo_search|run_check/);
});

test('#540 successful PreparedImplementation keeps direct repository tools visible in action_required', () => {
  const state = preparedController(1);
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.equal(state.checkToolCall('read', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('read', false);
  assert.equal(state.productiveProgressState(), 'action_required');

  const current = surface(state);
  for (const tool of ['read', 'repo_search', 'indexed_repo_search', 'bash']) assert.ok(current.includes(tool), tool);
  for (const tool of ['safe_edit', 'write', 'begin_coding_session', 'rollback_last_mutation', 'submit_result', 'request_large_mutation_budget']) {
    assert.ok(current.includes(tool), `existing action/control tool missing: ${tool}`);
  }
  assert.ok(!current.includes('run_check'));
  assert.match(activeToolGuidance(current), /read/);
  assert.match(activeToolGuidance(current), /repo_search/);
  assert.match(activeToolGuidance(current), /indexed_repo_search/);
  assert.match(activeToolGuidance(current), /bash/);
  assert.doesNotMatch(activeToolGuidance(current), /\brun_check\b/);
});

test('#398 large-mutation state keeps the bounded missing-fact escape executable', () => {
  const state = preparedController(0);
  const cfg = stageConfig('implementer').productiveProgress;
  assert.equal(state.productiveProgressState(), 'action_required');
  assert.equal(state.armAutomaticLargeMutationBudget(true), true);
  assert.equal(state.maybeGrantAutomaticLargeMutationBudget(), true);
  assert.equal(state.activateLargeMutationBudget(), true);

  const elevated = elevatedMutationTurnToolNames(ACTIVE, { blockerTool: cfg.blockerTool });
  assert.ok(elevated.includes('need_more_evidence'));
  assert.ok(!elevated.includes('read'));
  assert.ok(!elevated.includes('repo_search'));
  assert.ok(!elevated.includes('indexed_repo_search'));
  assert.ok(!elevated.includes('bash'));
  assert.ok(!elevated.includes('run_check'));

  assert.equal(state.checkToolCall('need_more_evidence', {
    missing: 'exact sibling contract',
    reason: 'the fact changes the implementation shape',
  }), undefined);
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.deepEqual(state.yieldLargeMutationBudgetForEvidence(), { yielded: true, rearmed: true });
  assert.equal(state.largeMutationBudgetState, 'idle');

  assert.equal(state.checkToolCall('read', { path: 'src/sibling.py' }), undefined);
  state.onToolExecutionEnd('read', false);
  assert.equal(state.productiveProgressState(), 'action_required');
  assert.equal(state.maybeGrantAutomaticLargeMutationBudget(), true, 'automatic large mutation is re-granted after the one evidence action');
  assert.equal(state.largeMutationBudgetState, 'pending');
});

test('#540 post-mutation state exposes run_check without hiding fresh Main direct repository tools', () => {
  const state = preparedController(0);
  assert.equal(state.checkToolCall('safe_edit', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('safe_edit', false);

  const current = surface(state);
  assert.ok(current.includes('run_check'));
  for (const tool of ['read', 'repo_search', 'indexed_repo_search', 'bash']) assert.ok(current.includes(tool), tool);
  assert.match(activeToolGuidance(current), /run_check/);
});

test('run_check exhaustion removes verification from the next authoritative guidance', () => {
  const state = preparedController(0);
  assert.equal(state.checkToolCall('safe_edit', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('safe_edit', false);
  assert.ok(surface(state).includes('run_check'));

  assert.equal(state.checkToolCall('run_check', { kind: 'ruff', paths: ['src/example.py'] }), undefined);
  state.onToolExecutionEnd('run_check', false);

  const current = surface(state);
  assert.ok(!current.includes('run_check'));
  for (const tool of ['read', 'repo_search', 'indexed_repo_search', 'bash']) assert.ok(current.includes(tool), tool);
  assert.doesNotMatch(activeToolGuidance(current), /\brun_check\b/);
});

test('#540 direct repository tools need no evidence unlock after a successful fresh handoff', () => {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.onTurnStart(0);
  state.applyPreparedImplementation({
    status: 'prepared',
    plan: ['inspect and implement'],
    complexity: 'nontrivial',
    largeMutation: false,
    reason: 'test',
  });
  assert.equal(state.productiveProgressState(), 'action_required');
  assert.deepEqual(
    new Set(state.directActionToolNames()),
    new Set(['read', 'repo_search', 'indexed_repo_search', 'bash']),
  );
  assert.equal(state.checkToolCall('read', { path: 'src/example.py' }), undefined);
  assert.equal(state.checkToolCall('repo_search', { query: 'Example' }), undefined);
  assert.equal(state.checkToolCall('indexed_repo_search', { query: 'Example' }), undefined);
  assert.equal(state.checkToolCall('bash', { command: 'git status --short' }), undefined);
});

test('#540 resume/repair-style direct action does not inherit fresh Main repository-tool broadening', () => {
  const cfg = stageConfig('implementer');
  const state = new ProgressController({
    ...cfg,
    requireComplexity: false,
    productiveProgress: { ...cfg.productiveProgress, startState: 'action_required' },
  }, {});
  state.onTurnStart(0);
  assert.deepEqual(state.directActionToolNames(), []);
  assert.match(state.checkToolCall('read', { path: 'src/example.py' }).reason, /productive progress requires an action/);
  assert.match(
    state.checkToolCall('bash', { command: 'pytest tests/example.py' }).reason,
    /limited to a bounded git diff\/status/,
  );
});

test('runtime counts an attempted tool that is absent from the current surface', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-active-tool-guidance-'));
  try {
    const context = path.join(dir, 'issue.json');
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(context, JSON.stringify({ title: 'Example task', body: 'Example' }));
    // The runtime imports typebox, but this child-process test only exercises event hooks.
    // Stub the module so the fixture stays dependency-light and does not depend on node_modules.
    fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'typebox') return {
        url: 'data:text/javascript,' + encodeURIComponent('export const Type = new Proxy({}, {get: () => (...args) => ({})});'),
        shortCircuit: true,
      };
      return nextResolve(specifier, context);
    }`);
    const script = `
      import assert from 'node:assert/strict';
      import { EventEmitter } from 'node:events';
      const { default: runtime } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      const bus = new EventEmitter();
      const handlers = new Map();
      let active = ['safe_edit', 'submit_result'];
      const pi = {
        events: { on: (e, fn) => { bus.on(e, fn); return () => bus.off(e, fn); }, emit: (...a) => bus.emit(...a) },
        registerTool: () => {},
        on: (name, fn) => handlers.set(name, fn),
        getActiveTools: () => [...active],
        setActiveTools: names => { active = names; },
        setModel: async () => true,
        sendUserMessage: async () => {},
      };
      runtime(pi);
      handlers.get('turn_start')({ turnIndex: 0 });
      const blocked = await handlers.get('tool_call')(
        { toolName: 'read', toolCallId: 'missing-1', input: { path: 'x.py' } },
        { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 2048 }, abort: () => {} },
      );
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /not currently exposed/);
      assert.match(blocked.reason, /CURRENTLY EXPOSED TOOLS/);
      assert.doesNotMatch(blocked.reason.split('CURRENTLY EXPOSED TOOLS')[1], /\\bread\\b/);

      // Provider-facing aliases are compared before controller canonicalization.
      active = ['retry_last_failed_check'];
      const retryAlias = await handlers.get('tool_call')(
        { toolName: 'retry_last_failed_check', toolCallId: 'retry-alias', input: {} },
        { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 2048 }, abort: () => {} },
      );
      assert.equal(retryAlias.block, true);
      assert.match(retryAlias.reason, /no unresolved failed run_check scope/);
      assert.doesNotMatch(retryAlias.reason, /not currently exposed/);

      // Once the runtime owns the surface, an explicitly empty surface is authoritative:
      // no ordinary tool call is valid until the runtime exposes one again.
      active = [];
      const emptySurface = await handlers.get('tool_call')(
        { toolName: 'write', toolCallId: 'empty-surface', input: { path: 'x.py', content: 'x' } },
        { cwd: ${JSON.stringify(dir)}, model: { maxTokens: 2048 }, abort: () => {} },
      );
      assert.equal(emptySurface.block, true);
      assert.match(emptySurface.reason, /CURRENTLY EXPOSED TOOLS \\(authoritative\\): none/);
    `;
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PI_STAGE: 'implementer',
        PI_ISSUE_CONTEXT: context,
        PI_RESUME_ACTIVE: 'true',
        PI_VALIDATION_REPAIR: 'false',
      },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr + result.stdout, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"count":1/);
    assert.match(result.stderr + result.stdout, /PI_UNAVAILABLE_TOOL_ATTEMPT .*"count":2.*"attemptedTool":"write"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

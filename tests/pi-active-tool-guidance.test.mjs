import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ProgressController, actionRequiredToolNames } from '../scripts/pi-common/progress-controller.mjs';
import { activeToolGuidance } from '../scripts/pi-common/session-state.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

const ACTIVE = [
  'read',
  'repo_search',
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
    blockerTool: cfg.blockerTool,
    verificationTools: state.verificationPermitted() ? [cfg.verificationTool] : [],
  });
}

function preparedController(evidenceBudget = 1) {
  const state = new ProgressController(stageConfig('implementer'), {});
  state.onTurnStart(0);
  assert.equal(state.checkToolCall('prepare_implementation', {}), undefined);
  state.setComplexity('nontrivial');
  state.setEvidenceBudget(evidenceBudget);
  state.onToolExecutionEnd('prepare_implementation', false);
  return state;
}

test('activeToolGuidance names only the authoritative current surface', () => {
  const guidance = activeToolGuidance(['safe_edit', 'submit_result', 'safe_edit']);
  assert.match(guidance, /safe_edit, submit_result/);
  assert.doesNotMatch(guidance, /read|repo_search|run_check/);
});

test('evidence exhaustion removes read, search, and unpermitted run_check from guidance immediately', () => {
  const state = preparedController(1);
  assert.equal(state.productiveProgressState(), 'evidence_allowed');
  assert.equal(state.checkToolCall('read', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('read', false);
  assert.equal(state.productiveProgressState(), 'action_required');

  const current = surface(state);
  assert.ok(!current.includes('read'));
  assert.ok(!current.includes('repo_search'));
  assert.ok(!current.includes('run_check'));
  assert.doesNotMatch(activeToolGuidance(current), /\bread\b|\brepo_search\b|\brun_check\b/);
});

test('post-mutation restriction exposes one run_check permit but keeps exploration tools hidden', () => {
  const state = preparedController(0);
  assert.equal(state.checkToolCall('safe_edit', { path: 'src/example.py' }), undefined);
  state.onToolExecutionEnd('safe_edit', false);

  const current = surface(state);
  assert.ok(current.includes('run_check'));
  assert.ok(!current.includes('read'));
  assert.ok(!current.includes('repo_search'));
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
  assert.doesNotMatch(activeToolGuidance(current), /\brun_check\b/);
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
      let active = ['prepare_implementation', 'submit_result'];
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

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildStageRunSpec } from '../scripts/pi-run-stage.mjs';
import { buildPiInvocation } from '../scripts/pi-common/pi-stage-backend.mjs';
import { createStageRunResult, createStageRunSpec } from '../scripts/pi-common/stage-run-contract.mjs';

function specFor(stage) {
  return createStageRunSpec({
    stage,
    cwd: '/work',
    prompt: 'do the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: { PI_STAGE: stage, PI_PHASE: stage },
    artifacts: {
      terminalResultPath: '/tmp/terminal',
      metricsPath: '/tmp/metrics.jsonl',
      rawLogPath: '/tmp/raw.jsonl',
    },
  });
}

test('buildStageRunSpec preserves the existing resolved Pi stage inputs', () => {
  const env = {
    RUNNER_TEMP: '/tmp/runner',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKSPACE: '/control',
    PI_MODEL: 'model-x',
    PI_PROVIDER: 'provider-x',
    PI_MODEL_BASE_URL: 'http://model/v1',
    PI_ISSUE: '42',
  };

  const { spec, workspace } = buildStageRunSpec({
    stage: 'dispatcher',
    cwd: '/work',
    raw: '/tmp/raw.jsonl',
  }, env);

  assert.equal(workspace, '/control');
  assert.equal(spec.stage, 'dispatcher');
  assert.equal(spec.cwd, '/work');
  assert.match(spec.prompt, /pi-dispatcher-context\.json/);
  assert.deepEqual(spec.model, {
    id: 'model-x',
    provider: 'provider-x',
    baseUrl: 'http://model/v1',
  });
  assert.equal(spec.environment.PI_STAGE, 'dispatcher');
  assert.equal(spec.environment.PI_PHASE, 'dispatcher');
  assert.equal(spec.environment.PI_ISSUE, '42');
  assert.equal(spec.environment.PI_BASH_TIMEOUT_SECONDS, '600');
  assert.equal(spec.artifacts.terminalResultPath, '/tmp/runner/pi-terminal-123-2');
  assert.equal(spec.artifacts.metricsPath, '/tmp/runner/pi-usage-123-2.jsonl');
  assert.equal(spec.artifacts.rawLogPath, '/tmp/raw.jsonl');
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.model));
  assert.ok(Object.isFrozen(spec.artifacts));
});

test('Pi backend invocation keeps the legacy extension and CLI argument order', () => {
  const invocation = buildPiInvocation(specFor('implementer'), '/control');

  assert.deepEqual(invocation.pi.args, [
    '--extension', '/control/scripts/pi-bash-timeout.mjs',
    '--extension', '/control/scripts/pi-agent-runtime.mjs',
    '--extension', '/control/scripts/pi-implementer-result-tool.mjs',
    '--provider', 'provider-x',
    '--model', 'model-x',
    '--mode', 'json',
    '--no-session',
    'do the task',
  ]);
  assert.equal(invocation.pi.command, 'pi');
  assert.equal(invocation.pi.options.cwd, '/work');
  assert.equal(invocation.pi.options.env.PI_STAGE, 'implementer');
  assert.equal(invocation.filter.options.env.PI_CALL, 'main');
  assert.deepEqual(invocation.filter.options.stdio, ['pipe', 'inherit', 'inherit']);
});

test('Pi architect invocation still loads repomap after the standard extensions', () => {
  const invocation = buildPiInvocation(specFor('architect'), '/control');
  const extensionValues = invocation.pi.args
    .map((value, index, args) => args[index - 1] === '--extension' ? value : null)
    .filter(Boolean);

  assert.deepEqual(extensionValues.slice(0, 3), [
    '/control/scripts/pi-bash-timeout.mjs',
    '/control/scripts/pi-agent-runtime.mjs',
    '/control/scripts/pi-architect-result-tool.mjs',
  ]);
  assert.match(extensionValues[3], /pi-repomap@a4a2c85685a7a06ec850b23a2ae1bb7c9ecde9ab$/);
});

test('StageRunResult exposes backend-neutral success metadata and artifact paths', () => {
  const result = createStageRunResult({
    backend: 'pi',
    durationMs: 1234,
    artifacts: specFor('dispatcher').artifacts,
  });

  assert.deepEqual(result, {
    backend: 'pi',
    status: 'succeeded',
    exitCode: 0,
    signal: null,
    durationMs: 1234,
    artifacts: {
      terminalResultPath: '/tmp/terminal',
      metricsPath: '/tmp/metrics.jsonl',
      rawLogPath: '/tmp/raw.jsonl',
    },
  });
  assert.ok(Object.isFrozen(result));
});

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildStageRunSpec, resolveStageBackend } from '../scripts/pi-run-stage.mjs';
import { buildMiniSweInvocation, miniSweMetricRecords } from '../scripts/pi-common/mini-swe-stage-backend.mjs';
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


test('mini-swe backend receives only the issue task instead of the Pi operating contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mini-swe-stage-'));
  const issueContext = join(dir, 'issue.json');
  writeFileSync(issueContext, JSON.stringify({
    number: 77,
    title: 'Implement a focused change',
    body: 'Acceptance criteria: update the product behavior.',
  }));

  const env = {
    RUNNER_TEMP: dir,
    GITHUB_WORKSPACE: '/control',
    PI_STAGE_BACKEND: 'mini-swe',
    PI_MODEL: 'qwen3.8-flash-next',
    PI_MODEL_BASE_URL: 'http://model/v1',
    PI_ISSUE_CONTEXT: issueContext,
    ISSUE: '77',
  };
  const { spec, backend } = buildStageRunSpec({ stage: 'implementer', cwd: '/work' }, env);

  assert.equal(backend, 'mini-swe');
  assert.match(spec.prompt, /issue worktree is already the current working directory/i);
  assert.match(spec.prompt, /Do not search for or modify other repository checkouts/i);
  assert.match(spec.prompt, /GitHub issue #77/);
  assert.match(spec.prompt, /Implement a focused change/);
  assert.match(spec.prompt, /Acceptance criteria/);
  assert.doesNotMatch(spec.prompt, /implementer_contract|prepare_implementation|productive-progress/i);
});

test('mini-swe invocation uses upstream yolo CLI with local OpenAI-compatible model settings', () => {
  const invocation = buildMiniSweInvocation(specFor('implementer'));

  assert.equal(invocation.command, 'mini');
  assert.deepEqual(invocation.args.slice(0, 14), [
    '-c', 'mini.yaml',
    '-c', 'model.model_kwargs.custom_llm_provider=openai',
    '-c', 'model.model_kwargs.api_base=http://model/v1',
    '-c', 'model.cost_tracking=ignore_errors',
    '-c', 'environment.cwd=/work',
    '-m', 'openai/model-x',
    '-y',
    '--exit-immediately',
  ]);
  assert.ok(invocation.args.includes('-l'));
  assert.ok(invocation.args.includes('0'));
  assert.ok(invocation.args.includes('-t'));
  assert.ok(invocation.args.includes('do the task'));
  assert.equal(invocation.options.cwd, '/work');
  assert.equal(invocation.options.env.GITHUB_WORKSPACE, '/work');
  assert.equal(invocation.options.env.PWD, '/work');
  assert.equal(invocation.options.env.MSWEA_CONFIGURED, 'true');
  assert.equal(invocation.options.env.MSWEA_COST_TRACKING, 'ignore_errors');
  assert.equal(invocation.options.env.OPENAI_API_KEY, 'local-mini-swe');
  assert.match(invocation.output, /terminal\.mini-swe-trajectory\.json$/);
});

test('mini-swe backend is explicit and limited to implementer', () => {
  assert.equal(resolveStageBackend({}), 'pi');
  assert.equal(resolveStageBackend({ PI_STAGE_BACKEND: 'mini-swe' }), 'mini-swe');
  assert.throws(() => resolveStageBackend({ PI_STAGE_BACKEND: 'other' }), /Unknown PI_STAGE_BACKEND/);
  assert.throws(() => buildMiniSweInvocation(specFor('architect')), /currently supports only the implementer stage/);
});

test('mini-swe trajectory usage maps into the shared PI_METRIC schema', () => {
  const records = miniSweMetricRecords({
    messages: [
      {
        role: 'assistant',
        extra: {
          response: {
            usage: {
              prompt_tokens: 120,
              completion_tokens: 30,
              total_tokens: 150,
              prompt_tokens_details: { cached_tokens: 40 },
            },
          },
        },
      },
      { role: 'tool', content: 'ignored' },
      {
        role: 'assistant',
        extra: { response: { usage: { input_tokens: 50, output_tokens: 10 } } },
      },
    ],
  }, { PI_ISSUE: '77', PI_PHASE: 'implementation' });

  assert.deepEqual(records, [
    {
      issue: 77,
      phase: 'implementation',
      call: 'main',
      response: 1,
      backend: 'mini-swe',
      usage: { input: 80, output: 30, cacheRead: 40, cacheWrite: 0, totalTokens: 150 },
      responseMs: 0,
    },
    {
      issue: 77,
      phase: 'implementation',
      call: 'main',
      response: 2,
      backend: 'mini-swe',
      usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60 },
      responseMs: 0,
    },
  ]);
});

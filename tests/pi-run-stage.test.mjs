import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

import { DEFAULT_MODEL_BASE_URL, buildStageRunSpec, forcePiProviderBaseUrl, isCountedProviderResponse, overrideProviderBaseUrl, resolveModelId, resolveStageBackend, runSelectedStage } from '../scripts/pi-run-stage.mjs';
import { buildMiniSweInvocation, discardModelPhaseLedger, miniSweMetricRecords } from '../scripts/pi-common/mini-swe-stage-backend.mjs';
import { readScript } from './helpers/resolved-source.mjs';
import { buildBootstrapInvocation, buildPiInvocation, runPiStage } from '../scripts/pi-common/pi-stage-backend.mjs';
import { PREPARED_IMPLEMENTATION_PLACEHOLDER, isFreshImplementerWork, withPreparedImplementation } from '../scripts/pi-common/stage-config.mjs';
import { writeImplementerResult } from '../scripts/pi-common/implementer-result.mjs';
import { createStageRunResult, createStageRunSpec } from '../scripts/pi-common/stage-run-contract.mjs';
import { createValidationRepairSpec, runStageWithValidationRecovery, validationErrorWithMutationCleanup, validationRepairHandoff, validationRepairPrompt } from '../scripts/pi-common/stage-validation-recovery.mjs';
import { captureMutationSnapshot } from '../scripts/pi-common/mutation-snapshot.mjs';
import { recordSuccessfulMutation } from '../scripts/pi-common/mutation-journal.mjs';
import { issueWorktreePatchPath } from '../scripts/pi-common/issue-worktree.mjs';
import {
  assertSuccessfulTerminalReceipt,
  createSuccessfulTerminalReceipt,
  writeTerminalReceiptFile,
} from '../scripts/pi-common/terminal-receipt.mjs';

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

function temporaryDirectory(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function implementerStartup(t, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-implementer-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issueContext = join(dir, 'issue.json');
  writeFileSync(issueContext, JSON.stringify({
    number: 42,
    title: 'Exercise implementer startup',
    body: 'Verify result-tool mode ordering.',
  }));

  return buildStageRunSpec({
    stage: 'implementer',
    cwd: '/work',
  }, {
    RUNNER_TEMP: dir,
    GITHUB_WORKSPACE: process.cwd(),
    PI_MODEL: 'model-x',
    PI_PROVIDER: 'provider-x',
    PI_MODEL_BASE_URL: 'http://model/v1',
    ISSUE: '42',
    PI_ISSUE_CONTEXT: issueContext,
    ...extraEnv,
  });
}

test('buildStageRunSpec preserves the existing resolved Pi stage inputs', () => {
  const env = {
    RUNNER_TEMP: '/tmp/runner',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKSPACE: process.cwd(),
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

  assert.equal(workspace, process.cwd());
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
  assert.equal(spec.environment.PI_VALIDATION_RUN_ID, '123-2');
  assert.equal(spec.environment.PI_ISSUE, '42');
  assert.equal(spec.environment.PI_BASH_TIMEOUT_SECONDS, '600');
  assert.equal(spec.artifacts.terminalResultPath, '/tmp/runner/pi-terminal-123-2');
  assert.equal(spec.artifacts.metricsPath, '/tmp/runner/pi-usage-123-2.jsonl');
  assert.equal(spec.environment.PI_MODEL_TRACE_FILE, '/tmp/runner/pi-model-trace-dispatcher-123-2.jsonl');
  assert.equal(spec.artifacts.rawLogPath, '/tmp/raw.jsonl');
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.model));
  assert.ok(Object.isFrozen(spec.artifacts));
});

test('versioned default model resolves qwen from the trusted control workspace', (t) => {
  const workspace = temporaryDirectory(t, 'pi-default-model-');
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  writeFileSync(join(workspace, '.pi', 'default-model'), 'qwen\n');

  assert.equal(
    resolveModelId({ GITHUB_WORKSPACE: workspace, PI_MODEL_CHOICE: 'default' }),
    'Qwen3.8-Flash-Next-NVFP4',
  );
});

test('explicit laguna workflow choice overrides the versioned qwen default', (t) => {
  const workspace = temporaryDirectory(t, 'pi-default-model-');
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  writeFileSync(join(workspace, '.pi', 'default-model'), 'qwen\n');

  assert.equal(
    resolveModelId({ GITHUB_WORKSPACE: workspace, PI_MODEL_CHOICE: 'laguna' }),
    'laguna-s-2.1-gguf',
  );
});

test('automatic runs use the versioned default and invalid or missing config fails loudly', (t) => {
  const workspace = temporaryDirectory(t, 'pi-default-model-');
  mkdirSync(join(workspace, '.pi'), { recursive: true });
  const defaultFile = join(workspace, '.pi', 'default-model');
  writeFileSync(defaultFile, 'qwen\n');

  assert.equal(
    resolveModelId({ GITHUB_WORKSPACE: workspace }),
    'Qwen3.8-Flash-Next-NVFP4',
  );

  writeFileSync(defaultFile, 'unknown-model\n');
  assert.throws(
    () => resolveModelId({ GITHUB_WORKSPACE: workspace, PI_MODEL_CHOICE: 'default' }),
    /Invalid default Pi model/,
  );

  const missingWorkspace = temporaryDirectory(t, 'pi-default-model-missing-');
  assert.throws(
    () => resolveModelId({ GITHUB_WORKSPACE: missingWorkspace, PI_MODEL_CHOICE: 'default' }),
    /Default Pi model config is missing/,
  );
});

test('local stage runs receive a process-unique validation run id that repair specs inherit', (t) => {
  const dir = temporaryDirectory(t, 'pi-local-validation-run-');
  const issueContext = join(dir, 'issue.json');
  writeFileSync(issueContext, JSON.stringify({ title: 'Local task', body: 'Exercise local validation identity.' }));

  const { spec } = buildStageRunSpec({
    stage: 'implementer',
    cwd: '/work',
  }, {
    RUNNER_TEMP: '/tmp/runner',
    GITHUB_WORKSPACE: process.cwd(),
    PI_MODEL: 'model-x',
    PI_VALIDATION_RUN_ID: '   ',
    ISSUE: '42',
    PI_ISSUE_CONTEXT: issueContext,
  });

  assert.equal(spec.environment.PI_VALIDATION_RUN_ID, `local-${process.pid}-1`);

  const repair = createValidationRepairSpec(spec, new Error('pytest failed'), 1);
  assert.equal(repair.environment.PI_VALIDATION_RUN_ID, spec.environment.PI_VALIDATION_RUN_ID);
});

test('explicit validation ids do not change GitHub-derived artifact filenames', () => {
  const { spec } = buildStageRunSpec({
    stage: 'dispatcher',
    cwd: '/work',
  }, {
    RUNNER_TEMP: '/tmp/runner',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKSPACE: process.cwd(),
    PI_MODEL: 'model-x',
    PI_VALIDATION_RUN_ID: 'custom-validation-id',
  });

  assert.equal(spec.environment.PI_VALIDATION_RUN_ID, 'custom-validation-id');
  assert.equal(spec.artifacts.terminalResultPath, '/tmp/runner/pi-terminal-123-2');
  assert.equal(spec.artifacts.metricsPath, '/tmp/runner/pi-usage-123-2.jsonl');
  assert.equal(spec.environment.PI_MODEL_TRACE_FILE, '/tmp/runner/pi-model-trace-dispatcher-123-2.jsonl');
});

test('blank GitHub run identifiers use one normalized local identity for validation and stage artifacts', () => {
  const { spec } = buildStageRunSpec({
    stage: 'dispatcher',
    cwd: '/work',
  }, {
    RUNNER_TEMP: '/tmp/runner',
    GITHUB_RUN_ID: '   ',
    GITHUB_RUN_ATTEMPT: '   ',
    GITHUB_WORKSPACE: process.cwd(),
    PI_MODEL: 'model-x',
  });

  const expected = `local-${process.pid}-1`;
  assert.equal(spec.environment.PI_VALIDATION_RUN_ID, expected);
  assert.equal(spec.artifacts.terminalResultPath, `/tmp/runner/pi-terminal-${expected}`);
  assert.equal(spec.artifacts.metricsPath, `/tmp/runner/pi-usage-${expected}.jsonl`);
  assert.equal(spec.environment.PI_MODEL_TRACE_FILE, `/tmp/runner/pi-model-trace-dispatcher-${expected}.jsonl`);
});

test('issue worktree patch names use normalized GitHub artifact identity semantics', () => {
  assert.equal(
    issueWorktreePatchPath('/tmp', {
      PI_VALIDATION_RUN_ID: 'validation-only',
      GITHUB_RUN_ID: ' 123 ',
      GITHUB_RUN_ATTEMPT: ' 2 ',
    }),
    '/tmp/pi-resume-123-2.patch',
  );
  assert.equal(
    issueWorktreePatchPath('/tmp', { GITHUB_RUN_ID: '   ', GITHUB_RUN_ATTEMPT: '   ' }),
    `/tmp/pi-resume-local-${process.pid}-1.patch`,
  );
});

test('#470 provider accounting counts only successful completion endpoints', () => {
  assert.equal(isCountedProviderResponse({
    requestMethod: 'POST',
    requestPath: '/v1/responses',
    status: 200,
    transportError: false,
  }), true);
  assert.equal(isCountedProviderResponse({
    requestMethod: 'POST',
    requestPath: '/v1/chat/completions?foo=bar',
    status: 201,
    transportError: false,
  }), true);

  for (const exchange of [
    { requestMethod: 'GET', requestPath: '/v1/models', status: 200, transportError: false },
    { requestMethod: 'POST', requestPath: '/v1/responses', status: 429, transportError: false },
    { requestMethod: 'POST', requestPath: '/v1/chat/completions', status: 500, transportError: false },
    { requestMethod: 'POST', requestPath: '/v1/responses', status: 200, transportError: true },
    { requestMethod: 'POST', requestPath: '/v1/embeddings', status: 200, transportError: false },
  ]) {
    assert.equal(isCountedProviderResponse(exchange), false, JSON.stringify(exchange));
  }
});


test('model endpoint defaults to the shared Open Responses server on port 4001', () => {
  const { spec } = buildStageRunSpec({
    stage: 'dispatcher',
    cwd: '/work',
  }, {
    RUNNER_TEMP: '/tmp/runner',
    GITHUB_WORKSPACE: process.cwd(),
    PI_MODEL: 'model-x',
  });

  assert.equal(spec.model.baseUrl, DEFAULT_MODEL_BASE_URL);
  assert.equal(new URL(spec.model.baseUrl).hostname, '192.168.8.184');
  assert.equal(new URL(spec.model.baseUrl).port, '4001');
});

test('Pi hp-laguna provider config is forced to the same stage endpoint', (t) => {
  const home = temporaryDirectory(t, 'pi-model-route-');
  const agentDir = join(home, '.pi', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const modelsFile = join(agentDir, 'models.json');
  writeFileSync(modelsFile, JSON.stringify({
    providers: {
      'hp-laguna': {
        baseUrl: 'http://192.168.8.210:4000/v1',
        models: [
          { id: 'laguna-s-2.1-gguf', baseUrl: 'http://192.168.8.210:3009/v1' },
          { id: 'Qwen3.8-Flash-Next-NVFP4' },
        ],
        modelOverrides: {
          'laguna-s-2.1-gguf': { baseUrl: 'http://192.168.8.210:4000/v1' },
        },
      },
      other: { baseUrl: 'http://example.invalid/v1' },
    },
  }));

  forcePiProviderBaseUrl({
    provider: 'hp-laguna',
    baseUrl: DEFAULT_MODEL_BASE_URL,
  }, { HOME: home });

  const config = JSON.parse(readFileSync(modelsFile, 'utf8'));
  assert.equal(config.providers['hp-laguna'].baseUrl, DEFAULT_MODEL_BASE_URL);
  assert.equal(config.providers['hp-laguna'].models[0].baseUrl, DEFAULT_MODEL_BASE_URL);
  assert.equal(config.providers['hp-laguna'].models[1].baseUrl, DEFAULT_MODEL_BASE_URL);
  assert.equal(config.providers['hp-laguna'].modelOverrides['laguna-s-2.1-gguf'].baseUrl, DEFAULT_MODEL_BASE_URL);
  assert.equal(config.providers.other.baseUrl, 'http://example.invalid/v1');
});

test('legacy base URL forcing stays hp-laguna-only while trace override targets the selected provider', (t) => {
  const home = temporaryDirectory(t, 'pi-provider-route-');
  const agentDir = join(home, '.pi', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const modelsFile = join(agentDir, 'models.json');
  writeFileSync(modelsFile, JSON.stringify({ providers: {
    'hp-laguna': { baseUrl: 'http://laguna/v1', models: [{ id: 'm1', baseUrl: 'http://laguna/v1' }] },
    openai: { baseUrl: 'http://openai/v1', models: [{ id: 'm2', baseUrl: 'http://openai/v1' }] },
  } }));

  forcePiProviderBaseUrl({ provider: 'openai', baseUrl: 'http://proxy/v1' }, { HOME: home });
  let config = JSON.parse(readFileSync(modelsFile, 'utf8'));
  assert.equal(config.providers.openai.baseUrl, 'http://openai/v1');
  assert.equal(config.providers['hp-laguna'].baseUrl, 'http://laguna/v1');

  overrideProviderBaseUrl({ provider: 'openai', baseUrl: 'http://proxy/v1' }, { HOME: home });
  config = JSON.parse(readFileSync(modelsFile, 'utf8'));
  assert.equal(config.providers.openai.baseUrl, 'http://proxy/v1');
  assert.equal(config.providers.openai.models[0].baseUrl, 'http://proxy/v1');
  assert.equal(config.providers['hp-laguna'].baseUrl, 'http://laguna/v1');

  overrideProviderBaseUrl({ provider: 'openai', baseUrl: 'http://openai/v1' }, { HOME: home });
  config = JSON.parse(readFileSync(modelsFile, 'utf8'));
  assert.equal(config.providers.openai.baseUrl, 'http://openai/v1');
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
    '--session-dir', '/tmp/terminal.pi-sessions',
    'do the task',
  ]);
  assert.equal(invocation.pi.command, 'pi');
  assert.equal(invocation.pi.options.cwd, '/work');
  assert.equal(invocation.pi.options.env.PI_STAGE, 'implementer');
  assert.equal(invocation.filter.options.env.PI_CALL, 'main');
  assert.deepEqual(invocation.filter.options.stdio, ['pipe', 'inherit', 'inherit']);
});

test('restored implementer env is present in the Pi child when the result-tool extension is loaded', (t) => {
  const resumePatch = '/tmp/pi-resume.patch';
  const { spec, workspace } = implementerStartup(t, {
    PI_RESUME_ACTIVE: 'true',
    PI_RESUME_PATCH: resumePatch,
  });
  const invocation = buildPiInvocation(spec, workspace);

  assert.equal(invocation.pi.options.env.PI_RESUME_ACTIVE, 'true');
  assert.equal(invocation.pi.options.env.PI_RESUME_PATCH, resumePatch);
  assert.equal(invocation.pi.options.env.PI_VALIDATION_REPAIR, undefined);
  assert.ok(invocation.pi.args.includes(join(workspace, 'scripts', 'pi-implementer-result-tool.mjs')));
});

test('validation-repair env is present in the Pi child when the result-tool extension is loaded', (t) => {
  const { spec, workspace } = implementerStartup(t);
  const repair = createValidationRepairSpec(spec, new Error('ruff failed'), 1);
  const invocation = buildPiInvocation(repair, workspace);

  assert.equal(invocation.pi.options.env.PI_VALIDATION_REPAIR, 'true');
  assert.equal(invocation.pi.options.env.PI_VALIDATION_REPAIR_ATTEMPT, '1');
  assert.equal(invocation.pi.options.env.PI_CALL, 'repair');
  assert.ok(invocation.pi.args.includes(join(workspace, 'scripts', 'pi-implementer-result-tool.mjs')));
});

test('fresh implementer starts without restored or validation-repair mode env', (t) => {
  const { spec, workspace } = implementerStartup(t);
  const invocation = buildPiInvocation(spec, workspace);

  assert.equal(invocation.pi.options.env.PI_RESUME_ACTIVE, undefined);
  assert.equal(invocation.pi.options.env.PI_RESUME_PATCH, undefined);
  assert.equal(invocation.pi.options.env.PI_VALIDATION_REPAIR, undefined);
  assert.ok(invocation.pi.args.includes(join(workspace, 'scripts', 'pi-implementer-result-tool.mjs')));
});

test('only stages offering the coding session persist a forkable session', () => {
  for (const stage of ['dispatcher', 'reviewer', 'triage']) {
    const args = buildPiInvocation(specFor(stage), '/control').pi.args;
    assert.ok(args.includes('--no-session'), stage);
    assert.ok(!args.includes('--session-dir'), stage);
  }
});

test('Pi repair invocation is labelled separately in shared metrics', () => {
  const repair = createValidationRepairSpec(
    specFor('implementer'),
    new Error('ruff failed'),
    1,
  );
  const invocation = buildPiInvocation(repair, '/control');

  assert.equal(invocation.filter.options.env.PI_CALL, 'repair');
  assert.equal(invocation.pi.options.env.PI_VALIDATION_REPAIR, 'true');
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


test('validation repair spec is backend-neutral and keeps the same worktree and artifacts', () => {
  const spec = specFor('implementer');
  const repair = createValidationRepairSpec(spec, new Error('ruff check . failed\nF841 unused variable'), 1);

  assert.equal(repair.stage, 'implementer');
  assert.equal(repair.cwd, spec.cwd);
  assert.deepEqual(repair.model, spec.model);
  assert.deepEqual(repair.artifacts, spec.artifacts);
  assert.equal(repair.environment.PI_VALIDATION_REPAIR, 'true');
  assert.equal(repair.environment.PI_VALIDATION_REPAIR_ATTEMPT, '1');
  assert.equal(repair.environment.PI_CALL, 'repair');
  assert.match(repair.prompt, /previous implementation attempt finished/i);
  assert.match(repair.prompt, /ruff check \. failed/);
  assert.match(repair.prompt, /F841 unused variable/);
  assert.match(repair.prompt, /Do not restart or re-plan/i);
});

test('shared validation recovery gives any implementer backend one focused repair attempt', async (t) => {
  const dir = temporaryDirectory(t, 'stage-validation-recovery-');
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: { PI_STAGE: 'implementer', PI_PHASE: 'implementation', PI_VALIDATION_LEDGER_FILE: join(dir, 'ledger.jsonl') },
    artifacts: {
      terminalResultPath: join(dir, 'terminal'),
      metricsPath: join(dir, 'metrics.jsonl'),
      rawLogPath: join(dir, 'raw.jsonl'),
    },
  });

  const attempts = [];
  let validations = 0;
  const result = await runStageWithValidationRecovery(
    spec,
    async candidate => {
      attempts.push(candidate);
      writeFileSync(candidate.artifacts.terminalResultPath, 'submitted\n');
      return createStageRunResult({
        backend: 'fake',
        durationMs: attempts.length,
        artifacts: candidate.artifacts,
      });
    },
    {
      validate: ({ cwd, ledgerPath, backend, env }) => {
        assert.equal(cwd, dir);
        assert.equal(ledgerPath, spec.environment.PI_VALIDATION_LEDGER_FILE);
        assert.equal(backend, 'fake');
        assert.equal(env, spec.environment);
        validations += 1;
        if (validations === 1) throw new Error('ruff check . failed\nBLE001 blind exception');
      },
    },
  );

  assert.equal(attempts.length, 2);
  assert.equal(validations, 2);
  assert.equal(attempts[0].environment.PI_VALIDATION_REPAIR, undefined);
  assert.equal(attempts[1].environment.PI_VALIDATION_REPAIR, 'true');
  assert.equal(attempts[1].environment.PI_CALL, 'repair');
  assert.equal(attempts[1].environment.PI_VALIDATION_LEDGER_FILE, spec.environment.PI_VALIDATION_LEDGER_FILE);
  assert.match(attempts[1].prompt, /BLE001 blind exception/);
  assert.equal(result.backend, 'fake');
  assert.equal(result.durationMs, 3);
});

test('trusted safe-fix drift routes into validation repair and resubmit', async (t) => {
  const root = temporaryDirectory(t, 'stage-safe-fix-resubmit-');
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Safe Fix Test');
  git('config', 'user.email', 'safe-fix@example.invalid');
  writeFileSync(join(dir, 'app.py'), 'value = 1\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const startCommit = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/dev', startCommit);
  writeFileSync(join(dir, 'app.py'), 'value = 2\n');

  // Match production topology: trusted runtime artifacts live in RUNNER_TEMP,
  // outside the issue worktree, so they never affect candidate identity.
  const resultFile = join(root, 'implementer-result.json');
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: {
      PI_STAGE: 'implementer',
      PI_PHASE: 'implementation',
      PI_IMPLEMENTER_RESULT_FILE: resultFile,
      PI_VALIDATION_LEDGER_FILE: join(root, 'ledger.jsonl'),
      PI_VALIDATION_RUN_ID: 'safe-fix-run',
      PI_IMPLEMENTER_START_COMMIT: startCommit,
    },
    artifacts: {
      terminalResultPath: join(root, 'terminal.json'),
      metricsPath: join(root, 'metrics.jsonl'),
      rawLogPath: null,
    },
  });

  const attempts = [];
  let validations = 0;
  const result = await runStageWithValidationRecovery(
    spec,
    async candidate => {
      attempts.push(candidate);
      writeImplementerResult(resultFile, {
        title: 'Safe fix candidate',
        summary: 'Exercise trusted validation mutation recovery.',
        changes: ['Update app value'],
        files: ['app.py'],
        security_notes: 'No security impact.',
        limitations: 'None.',
      });
      const env = {
        ...candidate.environment,
        PI_TERMINAL_RESULT_FILE: candidate.artifacts.terminalResultPath,
      };
      writeTerminalReceiptFile(
        candidate.artifacts.terminalResultPath,
        createSuccessfulTerminalReceipt({ cwd: dir, resultFile, env }),
      );
      return createStageRunResult({
        backend: 'fake',
        durationMs: 1,
        artifacts: candidate.artifacts,
      });
    },
    {
      validate: () => {
        validations += 1;
        if (validations === 1) {
          // Simulates Ruff's trusted safe-fix changing bytes after submit.
          writeFileSync(join(dir, 'app.py'), 'value = 3\n');
        }
      },
    },
  );

  assert.equal(attempts.length, 2);
  assert.equal(validations, 2);
  assert.equal(attempts[1].environment.PI_VALIDATION_REPAIR, 'true');
  assert.equal(readFileSync(join(dir, 'app.py'), 'utf8'), 'value = 3\n');
  assert.doesNotThrow(() => assertSuccessfulTerminalReceipt({
    cwd: dir,
    resultFile,
    env: {
      ...attempts[1].environment,
      PI_TERMINAL_RESULT_FILE: spec.artifacts.terminalResultPath,
    },
  }));
  assert.equal(result.backend, 'fake');
});

test('runtime failure metadata is cleared before every backend attempt', async (t) => {
  const dir = temporaryDirectory(t, 'stage-runtime-failure-reset-');
  const failureFile = join(dir, 'runtime-failure.json');
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: {
      PI_STAGE: 'implementer',
      PI_PHASE: 'implementation',
      PI_RUNTIME_FAILURE_FILE: failureFile,
      PI_VALIDATION_LEDGER_FILE: join(dir, 'ledger.jsonl'),
    },
    artifacts: {
      terminalResultPath: join(dir, 'terminal'),
      metricsPath: join(dir, 'metrics.jsonl'),
      rawLogPath: null,
    },
  });

  writeFileSync(failureFile, '{"failure_code":"STALE"}\n');
  let attempts = 0;
  let validations = 0;
  await runStageWithValidationRecovery(
    spec,
    async candidate => {
      attempts += 1;
      assert.equal(existsSync(failureFile), false, 'stale failure metadata is cleared before each backend attempt');
      writeFileSync(candidate.artifacts.terminalResultPath, 'submitted\n');
      if (attempts === 1) writeFileSync(failureFile, '{"failure_code":"FIRST_ATTEMPT"}\n');
      return createStageRunResult({ backend: 'fake', durationMs: 1, artifacts: candidate.artifacts });
    },
    {
      validate: () => {
        validations += 1;
        if (validations === 1) throw new Error('force repair');
      },
    },
  );

  assert.equal(attempts, 2);
  assert.equal(validations, 2);
  assert.equal(existsSync(failureFile), false, 'successful repair leaves no stale failure record');
});

test('successful stage clears recoverable runtime abort provenance while failed stage preserves it', async (t) => {
  const dir = temporaryDirectory(t, 'stage-runtime-failure-lifecycle-');
  const failureFile = join(dir, 'runtime-failure.json');
  const base = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: {
      PI_STAGE: 'implementer',
      PI_PHASE: 'implementation',
      PI_RUNTIME_FAILURE_FILE: failureFile,
    },
    artifacts: {
      terminalResultPath: join(dir, 'terminal'),
      metricsPath: join(dir, 'metrics.jsonl'),
      rawLogPath: null,
    },
  });

  writeFileSync(failureFile, '{"failure_code":"STALE"}\n');
  await runSelectedStage(base, { backend: 'pi', workspace: '/control' }, {
    runPi: async candidate => {
      writeFileSync(failureFile, '{"failure_code":"RECOVERED_NESTED"}\n');
      return createStageRunResult({ backend: 'pi', durationMs: 1, artifacts: candidate.artifacts });
    },
    validate: () => {},
  });
  assert.equal(existsSync(failureFile), false, 'successful overall stage removes recoverable abort provenance');

  await assert.rejects(
    runSelectedStage(base, { backend: 'pi', workspace: '/control' }, {
      runPi: async () => {
        writeFileSync(failureFile, '{"failure_code":"PI_ACTION_REQUIRED_ABORT"}\n');
        throw new Error('backend failed');
      },
      validate: () => {},
    }),
    /backend failed/,
  );
  assert.equal(existsSync(failureFile), true, 'failed overall stage preserves abort provenance for the workflow');
  assert.match(readFileSync(failureFile, 'utf8'), /PI_ACTION_REQUIRED_ABORT/);
});

test('Pi and mini-swe both run post-backend validation', async () => {
  for (const backend of ['pi', 'mini-swe']) {
    const spec = specFor('implementer');
    let calls = 0;
    let validations = 0;
    const fake = async candidate => {
      calls += 1;
      assert.equal(candidate, spec);
      return createStageRunResult({ backend, durationMs: 1, artifacts: candidate.artifacts });
    };
    const result = await runSelectedStage(spec, { backend, workspace: '/control' }, {
      runPi: fake,
      runMiniSwe: fake,
      validate: ({ cwd, backend: validatedBackend }) => {
        assert.equal(cwd, '/work');
        // Regression: the ledger must carry the real backend that produced the
        // result, not a value hardcoded to 'pi' -- a mini-swe implementer run's
        // checks_final records would otherwise be misattributed to Pi.
        assert.equal(validatedBackend, backend);
        validations += 1;
      },
    });
    assert.equal(result.backend, backend);
    assert.equal(calls, 1);
    assert.equal(validations, 1);
  }
});

test('shared validation harness treats blocked implementer outcome as terminal without validation repair', async (t) => {
  const dir = temporaryDirectory(t, 'stage-blocked-outcome-');
  const resultFile = join(dir, 'implementer-result.json');
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: {
      PI_STAGE: 'implementer',
      PI_PHASE: 'implementation',
      PI_IMPLEMENTER_RESULT_FILE: resultFile,
    },
    artifacts: {
      terminalResultPath: join(dir, 'terminal'),
      metricsPath: join(dir, 'metrics.jsonl'),
      rawLogPath: null,
    },
  });

  let validations = 0;
  let attempts = 0;
  const result = await runStageWithValidationRecovery(
    spec,
    async candidate => {
      attempts += 1;
      writeFileSync(candidate.artifacts.terminalResultPath, 'submitted\n');
      writeImplementerResult(resultFile, {
        title: 'Contradictory task',
        summary: 'The task cannot be implemented without violating an explicit constraint.',
        changes: [],
        outcome: 'blocked',
        blocked_reason: 'Requirement A requires behavior that constraint B explicitly forbids.',
        security_notes: 'No repository change was made.',
        limitations: 'Human clarification is required.',
      });
      return createStageRunResult({
        backend: 'fake',
        durationMs: 7,
        artifacts: candidate.artifacts,
      });
    },
    { validate: () => { validations += 1; } },
  );

  assert.equal(attempts, 1);
  assert.equal(validations, 0);
  assert.equal(result.backend, 'fake');
  assert.equal(result.durationMs, 7);
});

test('shared validation recovery stops after one failed repair attempt', async (t) => {
  const dir = temporaryDirectory(t, 'stage-validation-failure-');
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: { PI_STAGE: 'implementer', PI_PHASE: 'implementation' },
    artifacts: {
      terminalResultPath: join(dir, 'terminal'),
      metricsPath: join(dir, 'metrics.jsonl'),
      rawLogPath: null,
    },
  });

  let attempts = 0;
  await assert.rejects(
    runStageWithValidationRecovery(
      spec,
      async candidate => {
        attempts += 1;
        writeFileSync(candidate.artifacts.terminalResultPath, 'submitted\n');
        return createStageRunResult({
          backend: 'fake',
          durationMs: attempts,
          artifacts: candidate.artifacts,
        });
      },
      { validate: () => { throw new Error('still failing'); } },
    ),
    /still failing/,
  );
  assert.equal(attempts, 2);
});

test('#424 accepted-scope validation exposes callable targeted cleanup to repair', (t) => {
  const dir = temporaryDirectory(t, 'stage-mutation-cleanup-');
  const sidecar = join(dir, 'journal.json');
  const env = {
    PI_STAGE: 'implementer',
    PI_PHASE: 'implementation',
    PI_MUTATION_JOURNAL_FILE: sidecar,
  };
  const before = captureMutationSnapshot(dir, '.probe.txt');
  writeFileSync(join(dir, '.probe.txt'), 'scratch\n');
  const after = captureMutationSnapshot(dir, '.probe.txt');
  const entry = recordSuccessfulMutation({
    cwd: dir,
    before,
    after,
    tool: 'write',
    disposition: 'temporary',
    env,
  });
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: env,
    artifacts: {
      terminalResultPath: join(dir, 'terminal'),
      metricsPath: join(dir, 'metrics.jsonl'),
      rawLogPath: null,
    },
  });
  const failure = new Error(JSON.stringify({
    code: 'accepted_scope_violation',
    unexpected_paths: [],
    temporary_paths: ['.probe.txt'],
  }));
  const enriched = validationErrorWithMutationCleanup(failure, spec, {
    files: ['feature.py', '.probe.txt'],
  });

  assert.match(enriched.message, new RegExp(entry.id));
  assert.match(enriched.message, /undo_mutation/);
  assert.match(enriched.message, /expected_files:\["feature.py"\]/);
  assert.match(validationRepairPrompt(enriched), /Targeted mutation cleanup available/);
});

test('validation repair prompt keeps diagnostics bounded and focused', () => {
  const prompt = validationRepairPrompt(new Error('pytest failed: test_example'));
  assert.match(prompt, /pytest failed: test_example/);
  assert.match(prompt, /harness will run the authoritative checks again/i);
  assert.match(prompt, /Fix only the concrete validation failures/i);
});

test('mini-swe backend receives issue task plus worktree routing instead of the Pi operating contract', (t) => {
  const dir = temporaryDirectory(t, 'mini-swe-stage-');
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
    PI_MODEL: 'Qwen3.8-Flash-Next-NVFP4',
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
  assert.deepEqual(invocation.args.slice(0, 16), [
    '-c', 'mini.yaml',
    '-c', 'model.model_kwargs.custom_llm_provider=openai',
    '-c', 'model.model_kwargs.api_base=http://model/v1',
    '-c', 'model.cost_tracking=ignore_errors',
    '-c', 'model.model_kwargs.max_completion_tokens=16384',
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

test('mini-swe never receives the validation ledger path in its model-facing environment', () => {
  // mini-swe gives the model raw shell with this process's environment,
  // unlike Pi where the model only ever reaches a file through a trusted
  // tool handler. If the ledger path were visible here, the model could
  // forge a passing check -- or even the pipeline-completion marker --
  // before the harness-owned checks.final pipeline ever runs.
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: '/work',
    prompt: 'do the task',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: { PI_STAGE: 'implementer', PI_PHASE: 'implementer', PI_VALIDATION_LEDGER_FILE: '/tmp/pi-validation-ledger-1-1.jsonl' },
    artifacts: {
      terminalResultPath: '/tmp/terminal',
      metricsPath: '/tmp/metrics.jsonl',
      rawLogPath: '/tmp/raw.jsonl',
    },
  });
  const invocation = buildMiniSweInvocation(spec);
  assert.equal(invocation.options.env.PI_VALIDATION_LEDGER_FILE, undefined);
  assert.ok(!Object.keys(invocation.options.env).includes('PI_VALIDATION_LEDGER_FILE'));
});

test('discardModelPhaseLedger removes whatever is at the ledger path, not just hides it', (t) => {
  // The path is mechanically derivable by a raw-shell agent (RUNNER_TEMP +
  // GITHUB_RUN_ID + GITHUB_RUN_ATTEMPT + the naming template committed in
  // the workflow file) even though modelFacingEnv hides the variable name.
  // The actual guarantee has to be that nothing written there survives, not
  // that the agent doesn't know where to write it -- so this must delete
  // real forged content, not merely be a documented intention.
  const dir = temporaryDirectory(t, 'mini-swe-ledger-');
  const ledgerPath = join(dir, 'ledger.jsonl');
  writeFileSync(ledgerPath, '{"kind":"python_compile","scope":{"paths":["x.py"]},"status":"pass","source":"run_check","stage":"implementer","backend":"mini-swe","run_id":"forged"}\n');
  discardModelPhaseLedger({ environment: { PI_VALIDATION_LEDGER_FILE: ledgerPath } });
  assert.equal(existsSync(ledgerPath), false);
});

test('discardModelPhaseLedger is a no-op when no ledger path is configured', () => {
  assert.doesNotThrow(() => discardModelPhaseLedger({ environment: {} }));
});

test('runMiniSweStage discards the ledger strictly after the child process exits and before computing the implementation result', () => {
  const source = readScript('scripts/pi-common/mini-swe-stage-backend.mjs', 'utf8');
  const waitIndex = source.indexOf("const code = await wait(child, 'mini-swe-agent');");
  const discardIndex = source.indexOf('discardModelPhaseLedger(spec);');
  const resultIndex = source.indexOf('writeImplementationResult(spec);');
  assert.ok(waitIndex >= 0 && discardIndex >= 0 && resultIndex >= 0);
  assert.ok(waitIndex < discardIndex, 'the ledger must be discarded only after the child process is confirmed exited');
  assert.ok(discardIndex < resultIndex, 'the ledger must be discarded before any later harness-owned step runs');
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
  const repairRecords = miniSweMetricRecords({
    messages: [{
      role: 'assistant',
      extra: { response: { usage: { prompt_tokens: 10, completion_tokens: 5 } } },
    }],
  }, { PI_ISSUE: '77', PI_PHASE: 'implementation', PI_CALL: 'repair' });
  assert.equal(repairRecords[0].call, 'repair');

});

// ---- #456: planner bootstrap runs in its own pi process before the main Implementer session ----

const PREPARED_ARTIFACT = {
  version: 1, status: 'prepared', plan: ['Locate the target', 'Apply the bounded change'], complexity: 'nontrivial',
  evidenceBudget: 2, largeMutation: false, reason: 'Needs one lookup', workspaceRoot: '/work', freshBaseCommit: 'abc123',
  baseRef: 'origin/dev', layoutHint: null, plannerUsage: null, plannerDurationMs: 1200,
};

// A fake `pi` on PATH: records every invocation (argv + selected env) in order; as the bootstrap
// process it writes the PreparedImplementation artifact, as the main process the terminal result.
function installFakePi(t, { bootstrapExit = 0 } = {}) {
  const dir = temporaryDirectory(t, 'pi-fake-bin-');
  const log = join(dir, 'invocations.jsonl');
  const script = join(dir, 'pi');
  writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const bootstrap = args.some(arg => arg.endsWith('pi-implementer-bootstrap.mjs'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, bootstrap, bootstrapEnv: process.env.PI_IMPLEMENTER_BOOTSTRAP ?? null, prepared: process.env.PI_PREPARED_IMPLEMENTATION_FILE ?? null }) + '\\n');
if (bootstrap) {
  if (${bootstrapExit} !== 0) process.exit(${bootstrapExit});
  fs.writeFileSync(process.env.PI_PREPARED_IMPLEMENTATION_FILE, ${JSON.stringify(JSON.stringify(PREPARED_ARTIFACT))});
  console.log('PI_BOOTSTRAP {"phase":"planner_completed"}');
  console.log('{"type":"session"}');
} else {
  fs.writeFileSync(process.env.PI_TERMINAL_RESULT_FILE, 'ok');
}
`, { mode: 0o755 });
  const invocations = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, invocations };
}

function bootstrapSpec(t, fake, environment = {}) {
  const dir = temporaryDirectory(t, 'pi-bootstrap-run-');
  return createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: `Issue text\n${PREPARED_IMPLEMENTATION_PLACEHOLDER}`,
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: { PATH: `${fake.dir}:${process.env.PATH}`, PI_TERMINAL_RESULT_FILE: join(dir, 'terminal'), PI_STAGE: 'implementer', PI_PHASE: 'implementation', PI_IMPLEMENTER_START_COMMIT: 'abc123', ...environment },
    artifacts: { terminalResultPath: join(dir, 'terminal'), metricsPath: join(dir, 'metrics.jsonl'), rawLogPath: join(dir, 'raw.jsonl') },
  });
}

test('only fresh Implementer work gets planner bootstrap; restored and repair work do not', () => {
  assert.equal(isFreshImplementerWork({ PI_STAGE: 'implementer' }), true);
  assert.equal(isFreshImplementerWork({ PI_STAGE: 'implementer', PI_RESUME_ACTIVE: 'false' }), true);
  assert.equal(isFreshImplementerWork({ PI_STAGE: 'implementer', PI_RESUME_ACTIVE: 'true' }), false);
  assert.equal(isFreshImplementerWork({ PI_STAGE: 'implementer', PI_VALIDATION_REPAIR: 'true' }), false);
  for (const stage of ['dispatcher', 'reviewer', 'repair', 'architect', 'triage']) {
    assert.equal(isFreshImplementerWork({ PI_STAGE: stage }), false, stage);
  }
});

test('bootstrap pi invocation is a prompt-less, session-less planner host', () => {
  const spec = createStageRunSpec({ ...specFor('implementer'), environment: { PI_STAGE: 'implementer' } });
  const { command, args, options } = buildBootstrapInvocation(spec, '/control');
  assert.equal(command, 'pi');
  assert.deepEqual(args, [
    '--extension', '/control/scripts/pi-implementer-bootstrap.mjs',
    '--provider', 'provider-x', '--model', 'model-x', '--mode', 'json', '--no-session',
  ]);
  assert.ok(!args.includes('do the task'), 'no prompt: the bootstrap process makes no model request of its own');
  assert.equal(options.env.PI_IMPLEMENTER_BOOTSTRAP, 'true');
  assert.equal(options.env.PI_PREPARED_IMPLEMENTATION_FILE, '/tmp/terminal.prepared-implementation.json');
});

test('withPreparedImplementation fills the placeholder, or appends trusted context for a custom prompt', () => {
  assert.equal(withPreparedImplementation(`a ${PREPARED_IMPLEMENTATION_PLACEHOLDER} b`, 'BLOCK'), 'a BLOCK b');
  assert.equal(withPreparedImplementation('custom prompt', 'BLOCK'), 'custom prompt\n\n<trusted_context>\nBLOCK\n</trusted_context>');
  assert.equal(withPreparedImplementation(`x ${PREPARED_IMPLEMENTATION_PLACEHOLDER}`, '$& $1'), 'x $& $1', 'replacement text is literal');
});

test('fresh Implementer: bootstrap pi completes first, then the main session starts with the prepared state in its first prompt', async (t) => {
  const fake = installFakePi(t);
  const spec = bootstrapSpec(t, fake);
  await runPiStage(spec, { workspace: process.cwd() });

  const [bootstrap, main, ...rest] = fake.invocations();
  assert.equal(rest.length, 0);
  assert.equal(bootstrap.bootstrap, true, 'planner bootstrap process runs first');
  assert.equal(bootstrap.bootstrapEnv, 'true');
  assert.ok(!bootstrap.args.some(arg => arg.includes('Issue text')), 'bootstrap receives no prompt');
  assert.equal(main.bootstrap, false);
  assert.equal(main.bootstrapEnv, null, 'main session is not a bootstrap session');
  assert.equal(main.prepared, `${spec.artifacts.terminalResultPath}.prepared-implementation.json`);
  const prompt = main.args.at(-1);
  assert.match(prompt, /Issue text/);
  assert.match(prompt, /Runtime-prepared implementation state/);
  assert.match(prompt, /1\. Locate the target\n2\. Apply the bounded change/);
  assert.match(prompt, /Evidence budget: 2/);
  assert.doesNotMatch(prompt, /prepare_implementation|runtime_prepared_implementation_state/);
  assert.ok(main.args.includes('--session-dir'), 'main Implementer keeps its forkable session');
  assert.ok(!bootstrap.args.includes('--session-dir'));
});

test('a crashed bootstrap process resolves PREPARATION_FALLBACK before the main session starts', async (t) => {
  const fake = installFakePi(t, { bootstrapExit: 3 });
  const spec = bootstrapSpec(t, fake);
  await runPiStage(spec, { workspace: process.cwd() });

  const [bootstrap, main] = fake.invocations();
  assert.equal(bootstrap.bootstrap, true);
  assert.equal(main.bootstrap, false);
  const prompt = main.args.at(-1);
  assert.match(prompt, /PREPARATION_FALLBACK/);
  assert.match(prompt, /bootstrap_process_failure/);
  assert.match(prompt, /nothing to prepare or retry/);
  assert.doesNotMatch(prompt, /prepare_implementation/);
  assert.equal(JSON.parse(readFileSync(main.prepared, 'utf8')).status, 'fallback');
});

test('restored and validation-repair Implementer runs never launch the planner bootstrap', async (t) => {
  for (const environment of [{ PI_RESUME_ACTIVE: 'true' }, { PI_VALIDATION_REPAIR: 'true' }]) {
    const fake = installFakePi(t);
    const spec = bootstrapSpec(t, fake, environment);
    await runPiStage(spec, { workspace: process.cwd() });
    const calls = fake.invocations();
    assert.equal(calls.length, 1, JSON.stringify(environment));
    assert.equal(calls[0].bootstrap, false);
    assert.equal(calls[0].prepared, null);
  }
});


test('#469 validation repair handoff is bounded, deterministic, and independent of parent transcript size', (t) => {
  const dir = temporaryDirectory(t, 'stage-repair-handoff-');
  const terminal = join(dir, 'terminal');
  const preparedPath = `${terminal}.prepared-implementation.json`;
  writeFileSync(preparedPath, JSON.stringify({
    version: 1,
    status: 'prepared',
    plan: ['Edit src/connect_four.py', 'Update tests/test_connect_four.py'],
    complexity: 'nontrivial',
    evidenceBudget: 1,
    largeMutation: true,
    reason: 'Source and direct smoke test both change.',
    workspaceRoot: dir,
    freshBaseCommit: 'abc123',
    baseRef: 'origin/dev',
    layoutHint: {
      sourceRoot: 'src',
      sourceDirectory: 'src',
      sourceTarget: 'src/connect_four.py',
      sourceConvention: 'src/tic_tac_toe.py',
      testDirectory: 'tests',
      testTarget: 'tests/test_connect_four.py',
      testTargetRequired: true,
      testConvention: 'tests/test_tic_tac_toe.py',
    },
    plannerUsage: null,
    plannerDurationMs: 100,
  }));
  const makeSpec = prompt => createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt,
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: { PI_STAGE: 'implementer', PI_PHASE: 'implementation' },
    artifacts: { terminalResultPath: terminal, metricsPath: join(dir, 'metrics.jsonl'), rawLogPath: null },
  });
  const result = {
    outcome: 'changed',
    title: 'Fix Connect Four smoke path',
    summary: 'Add source and direct smoke coverage.',
    changes: ['Fix import wiring', 'Add smoke coverage'],
    files: ['src/connect_four.py', 'tests/test_connect_four.py'],
  };
  const acceptedScope = {
    schema_version: 1,
    accepted: [
      { path: 'src/connect_four.py', disposition: 'publishable', rationale: 'source' },
      { path: 'tests/test_connect_four.py', disposition: 'publishable', rationale: 'test' },
    ],
  };
  const receipt = {
    receipt: {
      session_id: 'coding-session-469',
      candidate_revision: { digest: 'candidate-469' },
    },
  };
  const failure = new Error('pytest failed: tests/test_connect_four.py::test_smoke');
  const handoff = validationRepairHandoff(makeSpec('short'), failure, {
    implementerResult: result,
    terminalReceipt: receipt,
    acceptedScope,
  });
  assert.deepEqual(handoff.changed_files, ['src/connect_four.py', 'tests/test_connect_four.py']);
  assert.equal(handoff.completion.session_id, 'coding-session-469');
  assert.equal(handoff.completion.candidate_revision, 'candidate-469');
  assert.equal(handoff.prepared_implementation.layout_hint.sourceTarget, 'src/connect_four.py');
  assert.equal(handoff.prepared_implementation.layout_hint.testTarget, 'tests/test_connect_four.py');
  assert.equal(handoff.prepared_implementation.layout_hint.testTargetRequired, true);
  assert.match(handoff.validation_failure, /pytest failed/);

  const shortRepair = createValidationRepairSpec(makeSpec('short'), failure, 1, acceptedScope, result, receipt);
  const hugeRepair = createValidationRepairSpec(makeSpec('x'.repeat(1_000_000)), failure, 1, acceptedScope, result, receipt);
  assert.equal(shortRepair.prompt, hugeRepair.prompt, 'repair prompt must not grow with inherited transcript text');
  assert.ok(shortRepair.prompt.length < 30_000);
  assert.match(shortRepair.prompt, /Runtime repair handoff/);
  assert.match(shortRepair.prompt, /tests\/test_connect_four\.py/);
});


test('#469 repair handoff recomputes current changed files after a validation-time mutation', (t) => {
  const dir = temporaryDirectory(t, 'stage-repair-current-files-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Repair Handoff Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'repair@example.invalid'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  writeFileSync(join(dir, 'source.py'), 'VALUE = 1\n');
  const spec = createStageRunSpec({
    stage: 'implementer',
    cwd: dir,
    prompt: 'implement',
    model: { id: 'model-x', provider: 'provider-x', baseUrl: 'http://model/v1' },
    environment: { PI_STAGE: 'implementer', PI_PHASE: 'implementation' },
    artifacts: {
      terminalResultPath: join(dir, 'terminal'),
      metricsPath: join(dir, 'metrics.jsonl'),
      rawLogPath: null,
    },
  });
  const implementerResult = {
    outcome: 'changed',
    title: 'Change source',
    summary: 'Initial candidate',
    changes: ['Change source'],
    files: ['source.py'],
  };

  // Simulate a trusted validation safe-fix that changes the candidate after submit_result.
  writeFileSync(join(dir, 'validation_fix.py'), 'FIXED = True\n');
  const handoff = validationRepairHandoff(spec, new Error('final validation failed'), {
    implementerResult,
    terminalReceipt: {
      candidateRevision: { base_commit: baseCommit },
      receipt: {
        session_id: 'coding-469',
        candidate_revision: { base_commit: baseCommit, digest: 'before-validation-fix' },
      },
    },
  });
  assert.deepEqual(handoff.changed_files, ['source.py', 'validation_fix.py']);
});

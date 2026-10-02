import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';

import { IMPLEMENTER_RESPONSE_MAX_TOKENS } from './progress-controller.mjs';
import { baseRef } from './project-config.mjs';
import { integrateLatestDev } from './finalize-product-tree.mjs';
import { runGit as git } from './git.mjs';
import { writeImplementerResult } from './implementer-result.mjs';
import { createStageRunResult } from './stage-run-contract.mjs';

const BACKEND = 'mini-swe';
const gitPaths = text => text.split('\0').filter(Boolean);
function changedPathsAgainstBase() {
  const tracked = gitPaths(git(['diff', '--no-renames', '--name-only', '-z', baseRef()]).out);
  const untracked = gitPaths(git(['ls-files', '--others', '--exclude-standard', '-z']).out);
  return [...new Set([...tracked, ...untracked])].sort();
}

function wait(child, name) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${name} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function issueContext(env) {
  const file = env.PI_ISSUE_CONTEXT;
  if (!file || !fs.existsSync(file)) throw new Error('PI_ISSUE_CONTEXT is required for mini-swe implementer');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function trajectoryPath(spec) {
  return `${spec.artifacts.terminalResultPath}.mini-swe-trajectory.json`;
}

// Vars in this list are harness-trust-only: they name a file only this
// backend's own Node process (via the shared `validate()` call in
// stage-validation-recovery.mjs) is meant to read or write, never something
// the model-facing subprocess should see. Unlike Pi, where the model only
// ever reaches a file through a specific, trusted tool handler, mini-swe's
// whole paradigm is giving the model raw shell with its process environment
// -- so a var that is merely present here is a var the model can both read
// the path of and write to. PI_VALIDATION_LEDGER_FILE is the
// supposedly-authoritative validation ledger: if the model could see its
// path, it could forge a passing run_check-shaped record, or even the
// pipeline-completion marker, before the harness-owned checks.final ever
// runs.
const MODEL_ENV_BLOCKLIST = ['PI_VALIDATION_LEDGER_FILE'];

function modelFacingEnv(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !MODEL_ENV_BLOCKLIST.includes(key)));
}

export function buildMiniSweInvocation(spec) {
  if (spec.stage !== 'implementer') {
    throw new Error('mini-swe backend is experimental and currently supports only the implementer stage');
  }

  const output = trajectoryPath(spec);
  const model = spec.model.id.startsWith('openai/') ? spec.model.id : `openai/${spec.model.id}`;
  const args = [
    '-c', 'mini.yaml',
    '-c', 'model.model_kwargs.custom_llm_provider=openai',
    '-c', `model.model_kwargs.api_base=${spec.model.baseUrl}`,
    '-c', 'model.cost_tracking=ignore_errors',
    '-c', `model.model_kwargs.max_completion_tokens=${IMPLEMENTER_RESPONSE_MAX_TOKENS}`,
    '-c', `environment.cwd=${spec.cwd}`,
    '-m', model,
    '-y',
    '--exit-immediately',
    '-l', '0',
    '-o', output,
    '-t', spec.prompt,
  ];

  return {
    command: 'mini',
    args,
    output,
    options: {
      cwd: spec.cwd,
      env: {
        ...modelFacingEnv(spec.environment),
        GITHUB_WORKSPACE: spec.cwd,
        PWD: spec.cwd,
        MSWEA_CONFIGURED: 'true',
        MSWEA_COST_TRACKING: 'ignore_errors',
        OPENAI_API_KEY: spec.environment.OPENAI_API_KEY || 'local-mini-swe',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  };
}

export function miniSweMetricRecords(trajectory, env) {
  const issue = Number(env.PI_ISSUE || env.ISSUE || 0) || 0;
  const phase = env.PI_PHASE || 'implementation';
  const messages = Array.isArray(trajectory?.messages) ? trajectory.messages : [];
  const records = [];
  let response = 0;

  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    const usage = message?.extra?.response?.usage ?? {};
    const promptTokens = integer(usage.prompt_tokens ?? usage.input_tokens);
    const output = integer(usage.completion_tokens ?? usage.output_tokens);
    const cacheRead = Math.min(
      promptTokens,
      integer(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens),
    );
    records.push({
      issue,
      phase,
      call: env.PI_CALL || 'main',
      response: ++response,
      backend: BACKEND,
      usage: {
        input: Math.max(0, promptTokens - cacheRead),
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: integer(usage.total_tokens) || promptTokens + output,
      },
      responseMs: 0,
    });
  }
  return records;
}

function writeMetrics(spec, trajectory) {
  const records = miniSweMetricRecords(trajectory, spec.environment);
  fs.appendFileSync(
    spec.artifacts.metricsPath,
    records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
    { encoding: 'utf8', mode: 0o600 },
  );
  console.log(`PI_TASK ${JSON.stringify({
    issue: Number(spec.environment.PI_ISSUE || spec.environment.ISSUE || 0) || 0,
    phase: spec.environment.PI_PHASE || 'implementation',
    backend: BACKEND,
  })}`);
  for (const record of records) console.log(`PI_METRIC ${JSON.stringify(record)}`);
}

function writeImplementationResult(spec) {
  integrateLatestDev({
    conflictMessage: files => `Latest dev conflicts with the mini-swe implementation: ${files.join(', ')}`,
  });
  const changedPaths = changedPathsAgainstBase();
  if (!changedPaths.length) {
    throw new Error('mini-swe-agent submitted without repository changes; experimental backend does not infer already-satisfied');
  }

  const context = issueContext(spec.environment);
  const issue = spec.environment.PI_ISSUE || spec.environment.ISSUE || context.number || '';
  const target = spec.environment.PI_IMPLEMENTER_RESULT_FILE;
  if (!target) throw new Error('PI_IMPLEMENTER_RESULT_FILE is not configured');

  const metadata = {
    title: String(context.title ?? '').trim(),
    summary: `Experimental mini-swe-agent implementation${issue ? ` for issue #${issue}` : ''} was prepared against latest dev.`,
    changes: changedPaths,
    files: changedPaths,
    already_satisfied: false,
    security_notes: 'No dedicated security assessment was supplied by the experimental mini-swe-agent backend; independent review remains authoritative.',
    limitations: 'PR metadata is generated deterministically from the current diff rather than from Pi submit_result.',
  };
  if (!metadata.title) throw new Error('Issue title is required for mini-swe publication');

  writeImplementerResult(target, { ...metadata, outcome: 'changed' });
  fs.writeFileSync(
    spec.artifacts.terminalResultPath,
    JSON.stringify({ backend: BACKEND, status: 'submitted', changes: changedPaths }) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
}

/**
 * Excluding PI_VALIDATION_LEDGER_FILE from the model-facing environment
 * (modelFacingEnv) only hides the variable name; the exact path is still
 * mechanically derivable from other vars the model does have (RUNNER_TEMP,
 * GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT) plus the naming template committed in
 * this very workflow file, which mini-swe's raw shell can read. The real
 * guarantee cannot be "the agent doesn't know the path" -- it has to be
 * "nothing the agent could have written there survives." mini-swe has no
 * legitimate ledger producer during the model phase (no run_check tool
 * exists for it yet), so once the child process is confirmed exited,
 * anything at that path is necessarily forged. Call this immediately after
 * the child process is confirmed exited, strictly before the harness's own
 * checks.final pipeline (which runs after `runMiniSweStage` returns) ever
 * reads or appends to the ledger.
 */
export function discardModelPhaseLedger(spec) {
  const ledgerPath = spec.environment.PI_VALIDATION_LEDGER_FILE;
  if (ledgerPath) fs.rmSync(ledgerPath, { force: true });
}

export async function runMiniSweStage(spec) {
  const startedAt = Date.now();
  const invocation = buildMiniSweInvocation(spec);
  fs.rmSync(invocation.output, { force: true });

  const child = spawn(invocation.command, invocation.args, invocation.options);
  const streamDone = [];
  let rawStream = null;
  if (spec.artifacts.rawLogPath) {
    rawStream = fs.createWriteStream(spec.artifacts.rawLogPath, { flags: spec.environment.PI_VALIDATION_REPAIR === 'true' ? 'a' : 'w', mode: 0o600 });
  }

  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.pipe(destination, { end: false });
    if (rawStream) stream.pipe(rawStream, { end: false });
    streamDone.push(finished(stream));
  }

  const code = await wait(child, 'mini-swe-agent');
  discardModelPhaseLedger(spec);
  await Promise.all(streamDone);
  if (rawStream) {
    rawStream.end();
    await finished(rawStream);
  }
  if (code !== 0) throw new Error(`mini-swe-agent stage ${spec.stage} failed with exit code ${code}`);
  if (!fs.existsSync(invocation.output) || !fs.statSync(invocation.output).size) {
    throw new Error('mini-swe-agent exited without a trajectory');
  }

  const trajectory = JSON.parse(fs.readFileSync(invocation.output, 'utf8'));
  writeMetrics(spec, trajectory);
  if (trajectory?.info?.exit_status !== 'Submitted') {
    throw new Error(`mini-swe-agent did not submit successfully: ${trajectory?.info?.exit_status || 'unknown exit status'}`);
  }

  writeImplementationResult(spec);
  return createStageRunResult({
    backend: BACKEND,
    durationMs: Date.now() - startedAt,
    artifacts: spec.artifacts,
  });
}

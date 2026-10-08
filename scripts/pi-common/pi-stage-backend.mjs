import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { spawn } from 'node:child_process';

import { isFreshImplementerWork, stageConfig, withPreparedImplementation } from './stage-config.mjs';
import { bootstrapFailureFallback, preparedImplementationBlock, readPreparedImplementation, writePreparedImplementation } from './implementation-planner.mjs';
import { createStageRunResult } from './stage-run-contract.mjs';
import { assertSuccessfulTerminalReceipt } from './terminal-receipt.mjs';

const REPOMAP_PACKAGE = 'git:github.com/EnTeQuAk/pi-repomap@a4a2c85685a7a06ec850b23a2ae1bb7c9ecde9ab';

function wait(child, name) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${name} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

export function piSessionDir(spec) {
  return `${spec.artifacts.terminalResultPath}.pi-sessions`;
}

export function buildPiInvocation(spec, workspace) {
  // Lifecycle invariant: spec.environment is installed on the Pi child at process
  // creation, before Pi loads/registers any --extension module. Result tools snapshot
  // restore/validation-repair mode during registration, so those flags must already
  // be present in spec.environment when this invocation is built.
  const config = stageConfig(spec.stage);
  const extensions = [
    path.join(workspace, 'scripts/pi-bash-timeout.mjs'),
    path.join(workspace, 'scripts/pi-agent-runtime.mjs'),
    // Main-only prompt compaction; Planner bootstrap and coding child use separate invocations.
    ...(spec.stage === 'implementer' ? [path.join(workspace, 'scripts/pi-implementer-skill-index.mjs')] : []),
    path.join(workspace, `scripts/${config.resultTool}`),
  ];
  if (spec.stage === 'architect') extensions.push(REPOMAP_PACKAGE);

  const args = [];
  for (const extension of extensions) args.push('--extension', extension);
  args.push(
    '--provider', spec.model.provider,
    '--model', spec.model.id,
    '--mode', 'json',
    // The coding session forks this session's transcript (pi-subagents `context: 'fork'`
    // requires a persisted parent session). Sessions live next to the stage artifacts, outside
    // the worktree; every other stage stays session-less.
    ...(config.productiveProgress?.codingSessionTool
      ? ['--session-dir', piSessionDir(spec)]
      : ['--no-session']),
    spec.prompt,
  );

  return {
    pi: {
      command: 'pi',
      args,
      options: { cwd: spec.cwd, env: spec.environment, stdio: ['ignore', 'pipe', 'inherit'] },
    },
    filter: {
      command: process.execPath,
      args: [path.join(workspace, 'scripts/pi-log-filter.mjs')],
      options: {
        cwd: spec.cwd,
        env: { ...spec.environment, PI_CALL: spec.environment.PI_CALL || 'main' },
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    },
  };
}

export function preparedImplementationPath(spec) {
  return `${spec.artifacts.terminalResultPath}.prepared-implementation.json`;
}

// Session A: a separate short-lived Pi process hosts the implementation-planner and writes the
// PreparedImplementation artifact. It is launched WITHOUT a prompt, so it makes no model request
// of its own; it shuts down from session_start once the artifact is on disk.
export function buildBootstrapInvocation(spec, workspace) {
  const environment = {
    ...spec.environment,
    PI_IMPLEMENTER_BOOTSTRAP: 'true',
    PI_PREPARED_IMPLEMENTATION_FILE: preparedImplementationPath(spec),
  };
  return {
    command: 'pi',
    args: [
      '--extension', path.join(workspace, 'scripts/pi-implementer-bootstrap.mjs'),
      '--provider', spec.model.provider,
      '--model', spec.model.id,
      '--mode', 'json',
      '--no-session',
    ],
    options: { cwd: spec.cwd, env: environment, stdio: ['ignore', 'pipe', 'inherit'] },
  };
}

async function runBootstrap(spec, workspace) {
  const file = preparedImplementationPath(spec);
  fs.rmSync(file, { force: true });
  const bootstrapStartedAt = Date.now();
  const invocation = buildBootstrapInvocation(spec, workspace);
  const child = spawn(invocation.command, invocation.args, invocation.options);
  // Forward only the runtime's PI_* marker lines (PI_BOOTSTRAP, PI_SUBAGENT_*) to the job log; the
  // Pi JSON event stream is dropped. No log filter runs here: planner usage is already appended to
  // PI_METRICS_FILE as a descendant record, which the main session's filter replays exactly once.
  let pending = '';
  const forward = line => { if (line.startsWith('PI_')) process.stdout.write(`${line}\n`); };
  child.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(forward);
  });
  try {
    const code = await wait(child, 'pi bootstrap');
    forward(pending);
    if (code !== 0) throw new Error(`Pi implementer bootstrap failed with exit code ${code}`);
    const prepared = readPreparedImplementation(file);
    if (!prepared) throw new Error('Pi implementer bootstrap exited without a PreparedImplementation artifact');
    return prepared;
  } catch (error) {
    const reason = String(error?.message ?? error);
    console.warn(`PI_BOOTSTRAP ${JSON.stringify({ phase: 'process_failed', error: reason })}`);
    const fallback = bootstrapFailureFallback(spec.cwd, reason, spec.environment, Date.now() - bootstrapStartedAt);
    writePreparedImplementation(file, fallback);
    return fallback;
  }
}

export async function runPiStage(spec, { workspace }) {
  const startedAt = Date.now();
  if (isFreshImplementerWork(spec.environment)) {
    const prepared = await runBootstrap(spec, workspace);
    console.log(`PI_BOOTSTRAP ${JSON.stringify({ phase: 'main_session_starting', status: prepared.status })}`);
    spec = {
      ...spec,
      prompt: withPreparedImplementation(spec.prompt, preparedImplementationBlock(prepared, {
        largeMutationArmed: prepared.status === 'prepared' && prepared.largeMutation,
      })),
      environment: { ...spec.environment, PI_PREPARED_IMPLEMENTATION_FILE: preparedImplementationPath(spec) },
    };
  }
  const invocation = buildPiInvocation(spec, workspace);
  const pi = spawn(invocation.pi.command, invocation.pi.args, invocation.pi.options);
  const filter = spawn(invocation.filter.command, invocation.filter.args, invocation.filter.options);

  const tee = new PassThrough();
  const teeDone = finished(tee);
  pi.stdout.pipe(tee);
  tee.pipe(filter.stdin);

  let rawStream = null;
  let rawDone = Promise.resolve();
  if (spec.artifacts.rawLogPath) {
    rawStream = fs.createWriteStream(spec.artifacts.rawLogPath, { flags: spec.environment.PI_VALIDATION_REPAIR === 'true' ? 'a' : 'w', mode: 0o600 });
    rawDone = finished(rawStream);
    tee.pipe(rawStream);
  }

  const piCodePromise = wait(pi, 'pi');
  const filterCodePromise = wait(filter, 'pi-log-filter');
  const piCode = await piCodePromise;
  await teeDone;
  await rawDone;
  const filterCode = await filterCodePromise;

  const runtimeFailureFile = String(spec.environment.PI_RUNTIME_FAILURE_FILE ?? '').trim();
  if (runtimeFailureFile && fs.existsSync(runtimeFailureFile)) {
    let failure = null;
    try {
      failure = JSON.parse(fs.readFileSync(runtimeFailureFile, 'utf8'));
    } catch (error) {
      console.warn(`PI_RUNTIME_FAILURE_METADATA_INVALID ${JSON.stringify({ error: String(error?.message ?? error) })}`);
    }
    if (failure?.failure_code === 'PI_RUN_CHECK_PREFLIGHT_FAILED') {
      throw new Error(`${failure.failure_code}: ${failure.reason ?? failure.diagnostic ?? 'run_check preflight failed'}`);
    }
  }

  if (piCode !== 0) throw new Error(`Pi stage ${spec.stage} failed with exit code ${piCode}`);
  if (filterCode !== 0) throw new Error(`Pi log filter failed with exit code ${filterCode}`);
  if (!fs.existsSync(spec.artifacts.terminalResultPath) || !fs.statSync(spec.artifacts.terminalResultPath).size) {
    throw new Error(`Pi stage ${spec.stage} exited without its terminal tool`);
  }
  if (
    spec.stage === 'implementer' &&
    spec.environment.PI_IMPLEMENTER_RESULT_FILE &&
    spec.environment.PI_VALIDATION_RUN_ID
  ) {
    assertSuccessfulTerminalReceipt({
      cwd: spec.cwd,
      resultFile: spec.environment.PI_IMPLEMENTER_RESULT_FILE,
      env: { ...spec.environment, PI_TERMINAL_RESULT_FILE: spec.artifacts.terminalResultPath },
    });
  }

  return createStageRunResult({
    backend: 'pi',
    durationMs: Date.now() - startedAt,
    artifacts: spec.artifacts,
  });
}

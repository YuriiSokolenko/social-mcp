import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { spawn } from 'node:child_process';

import { stageConfig } from './stage-config.mjs';
import { createStageRunResult } from './stage-run-contract.mjs';

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

export function buildPiInvocation(spec, workspace) {
  const config = stageConfig(spec.stage);
  const extensions = [
    path.join(workspace, 'scripts/pi-bash-timeout.mjs'),
    path.join(workspace, 'scripts/pi-agent-runtime.mjs'),
    path.join(workspace, `scripts/${config.resultTool}`),
  ];
  if (spec.stage === 'architect') extensions.push(REPOMAP_PACKAGE);

  const args = [];
  for (const extension of extensions) args.push('--extension', extension);
  args.push(
    '--provider', spec.model.provider,
    '--model', spec.model.id,
    '--mode', 'json',
    '--no-session',
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
        env: { ...spec.environment, PI_CALL: 'main' },
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    },
  };
}

export async function runPiStage(spec, { workspace }) {
  const startedAt = Date.now();
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
    rawStream = fs.createWriteStream(spec.artifacts.rawLogPath, { flags: 'w', mode: 0o600 });
    rawDone = finished(rawStream);
    tee.pipe(rawStream);
  }

  const piCodePromise = wait(pi, 'pi');
  const filterCodePromise = wait(filter, 'pi-log-filter');
  const piCode = await piCodePromise;
  await teeDone;
  await rawDone;
  const filterCode = await filterCodePromise;

  if (piCode !== 0) throw new Error(`Pi stage ${spec.stage} failed with exit code ${piCode}`);
  if (filterCode !== 0) throw new Error(`Pi log filter failed with exit code ${filterCode}`);
  if (!fs.existsSync(spec.artifacts.terminalResultPath) || !fs.statSync(spec.artifacts.terminalResultPath).size) {
    throw new Error(`Pi stage ${spec.stage} exited without its terminal tool`);
  }

  return createStageRunResult({
    backend: 'pi',
    durationMs: Date.now() - startedAt,
    artifacts: spec.artifacts,
  });
}

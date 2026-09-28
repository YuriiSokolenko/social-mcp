#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { stageConfig, stagePrompt } from './pi-common/stage-config.mjs';

function parseArgs(argv) {
  const [stage, ...rest] = argv;
  const options = { stage, promptFile: null, raw: null };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--prompt-file') options.promptFile = rest[++index];
    else if (value === '--raw') options.raw = rest[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.stage) throw new Error('usage: pi-run-stage.mjs <stage> [--prompt-file path] [--raw path]');
  return options;
}

function writeGithubEnv(env, name, value) {
  if (env.GITHUB_ENV) fs.appendFileSync(env.GITHUB_ENV, `${name}=${value}\n`);
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

export async function runStage({ stage, promptFile = null, raw = null }, env = process.env) {
  const config = stageConfig(stage);
  const prompt = promptFile ? fs.readFileSync(promptFile, 'utf8') : stagePrompt(stage, env);
  if (!prompt.trim()) throw new Error('Pi prompt is empty');

  const runnerTemp = env.RUNNER_TEMP || process.cwd();
  const suffix = `${env.GITHUB_RUN_ID ?? process.pid}-${env.GITHUB_RUN_ATTEMPT ?? 1}`;
  const childEnv = {
    ...env,
    PI_STAGE: stage,
    PI_PHASE: env.PI_PHASE ?? config.phase ?? stage,
    PI_ISSUE: env.PI_ISSUE ?? env.ISSUE ?? '',
    PI_BASH_TIMEOUT_SECONDS: env.PI_BASH_TIMEOUT_SECONDS ?? String(config.bashTimeoutSeconds),
    PI_TERMINAL_RESULT_FILE: env.PI_TERMINAL_RESULT_FILE ?? path.join(runnerTemp, `pi-terminal-${suffix}`),
    PI_METRICS_FILE: env.PI_METRICS_FILE ?? path.join(runnerTemp, `pi-usage-${suffix}.jsonl`),
  };
  writeGithubEnv(env, 'PI_METRICS_FILE', childEnv.PI_METRICS_FILE);
  writeGithubEnv(env, 'PI_PHASE', childEnv.PI_PHASE);
  if (childEnv.PI_ISSUE) writeGithubEnv(env, 'PI_ISSUE', childEnv.PI_ISSUE);
  fs.rmSync(childEnv.PI_TERMINAL_RESULT_FILE, { force: true });

  const workspace = env.GITHUB_WORKSPACE || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const extensions = [
    path.join(workspace, 'scripts/pi-bash-timeout.mjs'),
    path.join(workspace, 'scripts/pi-agent-runtime.mjs'),
  ];
  extensions.push(path.join(workspace, `scripts/${config.resultTool}`));
  const args = [];
  for (const extension of extensions) args.push('--extension', extension);
  args.push(
    '--provider', env.PI_PROVIDER || 'hp-laguna',
    '--model', env.PI_MODEL || 'laguna-s-2.1-gguf',
    '--mode', 'json',
    '--no-session',
    prompt,
  );

  const pi = spawn('pi', args, { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  const filter = spawn(process.execPath, [path.join(workspace, 'scripts/pi-log-filter.mjs')], {
    cwd: process.cwd(),
    env: { ...childEnv, PI_CALL: 'main' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  const tee = new PassThrough();
  const teeDone = finished(tee);
  pi.stdout.pipe(tee);
  tee.pipe(filter.stdin);

  let rawStream = null;
  let rawDone = Promise.resolve();
  if (raw) {
    rawStream = fs.createWriteStream(raw, { flags: 'w', mode: 0o600 });
    rawDone = finished(rawStream);
    tee.pipe(rawStream);
  }

  const piCodePromise = wait(pi, 'pi');
  const filterCodePromise = wait(filter, 'pi-log-filter');
  const piCode = await piCodePromise;
  await teeDone;
  await rawDone;
  const filterCode = await filterCodePromise;

  if (piCode !== 0) throw new Error(`Pi stage ${stage} failed with exit code ${piCode}`);
  if (filterCode !== 0) throw new Error(`Pi log filter failed with exit code ${filterCode}`);
  if (!fs.existsSync(childEnv.PI_TERMINAL_RESULT_FILE) || !fs.statSync(childEnv.PI_TERMINAL_RESULT_FILE).size) {
    throw new Error(`Pi stage ${stage} exited without its terminal tool`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStage(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

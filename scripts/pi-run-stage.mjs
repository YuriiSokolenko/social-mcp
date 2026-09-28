#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { stageConfig, stagePrompt } from './pi-common/stage-config.mjs';

// The hp-laguna backend (llama-server on nano) can only ever have ONE of
// these loaded at a time -- switching model here is a *claim* about what a
// human has already started on nano, not something this script can make
// true by itself. verifyModelIsLoaded() below checks that claim against
// reality and fails loudly instead of silently running the wrong model
// under the requested model's name (see PR #118 for the bug this replaces).
const MODEL_CHOICES = {
  laguna: { id: 'laguna-s-2.1-gguf', label: 'Laguna S 2.1' },
  qwen: { id: 'qwen3.8-flash-next', label: 'Qwen 3.8 Flash Next' },
};

function resolveModelId(env) {
  if (env.PI_MODEL) return env.PI_MODEL;
  const choice = env.PI_MODEL_CHOICE || 'laguna';
  const entry = MODEL_CHOICES[choice];
  if (!entry) {
    throw new Error(`Unknown PI_MODEL_CHOICE "${choice}", expected one of: ${Object.keys(MODEL_CHOICES).join(', ')}`);
  }
  return entry.id;
}

async function verifyModelIsLoaded(baseUrl, expectedId) {
  const url = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`Could not reach model server at ${url} to verify "${expectedId}" is loaded: ${error.message}`);
  }
  if (!res.ok) throw new Error(`Model status check failed: ${url} responded ${res.status}`);
  const body = await res.json();
  const loaded = (body.data ?? []).map((entry) => entry.id);
  if (!loaded.includes(expectedId)) {
    throw new Error(
      `Requested model "${expectedId}" is not loaded on ${baseUrl} (currently loaded: ${loaded.join(', ') || 'none'}). ` +
      'Start it on nano first (infra/llama-gguf-experimental/start_*.sh) or pick the model that is actually running.',
    );
  }
}

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

  const providerBaseUrl = env.PI_MODEL_BASE_URL || 'http://192.168.8.210:3009/v1';
  const modelId = resolveModelId(env);
  await verifyModelIsLoaded(providerBaseUrl, modelId);

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
    '--model', modelId,
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

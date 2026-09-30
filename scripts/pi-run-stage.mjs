#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { runMiniSweStage } from './pi-common/mini-swe-stage-backend.mjs';
import { runPiStage } from './pi-common/pi-stage-backend.mjs';
import { stageConfig, stagePrompt } from './pi-common/stage-config.mjs';
import { createStageRunSpec } from './pi-common/stage-run-contract.mjs';

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

export const DEFAULT_MODEL_BASE_URL = 'http://192.168.8.210:4001/v1';

function resolveModelId(env) {
  if (env.PI_MODEL) return env.PI_MODEL;
  const choice = env.PI_MODEL_CHOICE || 'laguna';
  const entry = MODEL_CHOICES[choice];
  if (!entry) {
    throw new Error(`Unknown PI_MODEL_CHOICE "${choice}", expected one of: ${Object.keys(MODEL_CHOICES).join(', ')}`);
  }
  return entry.id;
}

export function forcePiProviderBaseUrl(model, env = process.env) {
  if (model.provider !== 'hp-laguna') return;

  const agentDir = env.PI_AGENT_CONFIG_DIR || path.join(env.HOME || homedir(), '.pi', 'agent');
  const modelsFile = path.join(agentDir, 'models.json');
  if (!fs.existsSync(modelsFile)) {
    throw new Error(`Pi provider config is missing: ${modelsFile}`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse Pi provider config at ${modelsFile}: ${error.message}`);
  }

  const provider = config.providers?.[model.provider];
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error(`Pi provider "${model.provider}" is missing from ${modelsFile}`);
  }

  provider.baseUrl = model.baseUrl;

  if (Array.isArray(provider.models)) {
    for (const entry of provider.models) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entry.baseUrl = model.baseUrl;
    }
  }

  if (provider.modelOverrides && typeof provider.modelOverrides === 'object' && !Array.isArray(provider.modelOverrides)) {
    for (const entry of Object.values(provider.modelOverrides)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entry.baseUrl = model.baseUrl;
    }
  }

  fs.writeFileSync(modelsFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

export function resolveStageBackend(env = process.env) {
  const backend = env.PI_STAGE_BACKEND || 'pi';
  if (!['pi', 'mini-swe'].includes(backend)) {
    throw new Error(`Unknown PI_STAGE_BACKEND "${backend}", expected pi or mini-swe`);
  }
  return backend;
}

function miniSwePrompt(stage, env) {
  if (stage !== 'implementer') {
    throw new Error('mini-swe backend is experimental and currently supports only the implementer stage');
  }
  const contextFile = env.PI_ISSUE_CONTEXT;
  if (!contextFile) throw new Error('PI_ISSUE_CONTEXT is required for mini-swe implementer');
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  const issue = env.PI_ISSUE ?? env.ISSUE ?? context.number ?? '';
  return `Repository execution context:
- The issue worktree is already the current working directory.
- Work only inside this current working directory. Do not search for or modify other repository checkouts.

GitHub issue${issue ? ` #${issue}` : ''}

Title:
${String(context.title ?? '').trim()}

Body:
${String(context.body ?? '').trim()}`;
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

export function buildStageRunSpec({ stage, promptFile = null, raw = null, cwd = process.cwd() }, env = process.env) {
  const config = stageConfig(stage);
  const backend = resolveStageBackend(env);
  const prompt = promptFile
    ? fs.readFileSync(promptFile, 'utf8')
    : backend === 'mini-swe'
      ? miniSwePrompt(stage, env)
      : stagePrompt(stage, env);
  if (!prompt.trim()) throw new Error('Stage prompt is empty');

  const runnerTemp = env.RUNNER_TEMP || cwd;
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

  const workspace = env.GITHUB_WORKSPACE || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const spec = createStageRunSpec({
    stage,
    cwd,
    prompt,
    model: {
      id: resolveModelId(env),
      provider: env.PI_PROVIDER || 'hp-laguna',
      baseUrl: env.PI_MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL,
    },
    environment: childEnv,
    artifacts: {
      terminalResultPath: childEnv.PI_TERMINAL_RESULT_FILE,
      metricsPath: childEnv.PI_METRICS_FILE,
      rawLogPath: raw,
    },
  });

  return { spec, workspace, backend };
}

export async function runStage(options, env = process.env) {
  const { spec, workspace, backend } = buildStageRunSpec(options, env);
  if (backend === 'pi') forcePiProviderBaseUrl(spec.model, env);
  console.log(`PI_MODEL_ENDPOINT backend=${backend} provider=${spec.model.provider} base_url=${spec.model.baseUrl}`);

  writeGithubEnv(env, 'PI_METRICS_FILE', spec.artifacts.metricsPath);
  writeGithubEnv(env, 'PI_PHASE', spec.environment.PI_PHASE);
  if (spec.environment.PI_ISSUE) writeGithubEnv(env, 'PI_ISSUE', spec.environment.PI_ISSUE);
  fs.rmSync(spec.artifacts.terminalResultPath, { force: true });

  await verifyModelIsLoaded(spec.model.baseUrl, spec.model.id);
  if (backend === 'mini-swe') return runMiniSweStage(spec);
  return runPiStage(spec, { workspace });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStage(parseArgs(process.argv.slice(2))).catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

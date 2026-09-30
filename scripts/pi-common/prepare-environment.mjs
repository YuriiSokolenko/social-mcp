#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { projectConfig } from './project-config.mjs';

/**
 * Prepare a job worktree's toolchain from `environment` in the project config.
 *
 * Usage: prepare-environment.mjs <stage> <job-dir>
 *
 * Steps are fixed argv commands run in `job-dir`. Directories listed in
 * `environment.pathPrepend` (e.g. `.venv/bin`) are put on PATH for the steps
 * after they exist, and are appended to $GITHUB_PATH so later workflow steps
 * see the same toolchain. Nothing here is project-specific: which language,
 * package manager or pinned tool versions to use is entirely configuration.
 */
export function prepareEnvironment(stage, jobDir, { config = projectConfig(), env = process.env, run = spawnSync } = {}) {
  const steps = config.environment.stages[stage];
  if (!steps) throw new Error(`no environment steps configured for stage: ${stage}`);
  const dirs = config.environment.pathPrepend.map(dir => path.resolve(jobDir, dir));
  const pathEnv = () => [...dirs.filter(dir => fs.existsSync(dir)), env.PATH ?? ''].join(path.delimiter);
  for (const step of steps) {
    console.log(`+ ${step.name}: ${[step.command, ...step.args].join(' ')}`);
    const result = run(step.command, step.args, { cwd: jobDir, env: { ...env, PATH: pathEnv() }, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error(`environment step "${step.name}" failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}`);
    }
  }
  if (env.GITHUB_PATH) fs.appendFileSync(env.GITHUB_PATH, dirs.map(dir => `${dir}\n`).join(''));
  return dirs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stage, jobDir = process.env.JOB_DIR] = process.argv.slice(2);
  if (!stage || !jobDir) { console.error('usage: prepare-environment.mjs <stage> <job-dir>'); process.exit(2); }
  try { prepareEnvironment(stage, jobDir); } catch (error) { console.error(error.message); process.exit(1); }
}

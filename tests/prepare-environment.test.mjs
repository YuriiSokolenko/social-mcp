import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareEnvironment } from '../scripts/pi-common/prepare-environment.mjs';
import { parseConfigText, projectConfig } from '../scripts/pi-common/project-config.mjs';

test('environment steps run in order in the job dir, PATH gains the toolchain dir once it exists', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  const githubPath = path.join(jobDir, 'github_path');
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, path: options.env.PATH.split(path.delimiter)[0] });
    if (args.includes('venv')) fs.mkdirSync(path.join(jobDir, '.venv/bin'), { recursive: true });
    return { status: 0 };
  };
  prepareEnvironment('reviewer', jobDir, { env: { PATH: '/usr/bin', GITHUB_PATH: githubPath }, run });
  assert.deepEqual(calls.map(c => [c.command, c.args[0]]), [['python', '-m'], ['pip', 'install']]);
  assert.equal(calls[0].cwd, jobDir);
  assert.notEqual(calls[0].path, path.join(jobDir, '.venv/bin'));
  assert.equal(calls[1].path, path.join(jobDir, '.venv/bin'));
  assert.equal(fs.readFileSync(githubPath, 'utf8'), `${path.join(jobDir, '.venv/bin')}\n`);
});

test('a failing step aborts and unknown stages are rejected', () => {
  const failing = () => ({ status: 3 });
  assert.throws(() => prepareEnvironment('reviewer', os.tmpdir(), { env: {}, run: failing }), /create venv.*exit code 3/);
  assert.throws(() => prepareEnvironment('nope', os.tmpdir(), { env: {}, run: failing }), /no environment steps/);
});

test('every configured stage is a valid config the loader accepts', () => {
  assert.deepEqual(Object.keys(projectConfig().environment.stages).sort(), ['implementer', 'repair', 'reviewer']);
  assert.ok(parseConfigText(fs.readFileSync('.agent-harness.json', 'utf8')));
});

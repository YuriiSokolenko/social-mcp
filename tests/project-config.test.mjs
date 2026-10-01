import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_ENV, expandCommand, issueBranch, locateConfigFile, parseCheckpointRef, parseConfigText,
  parseIssueBranch, projectConfig, validateConfig, workflowFile,
} from '../scripts/pi-common/project-config.mjs';

const raw = () => JSON.parse(fs.readFileSync('.agent-harness.json', 'utf8'));

test('the committed config is valid and describes this repository', () => {
  const config = projectConfig();
  assert.equal(config.git.defaultBranch, 'dev');
  assert.equal(workflowFile('implementer'), 'pi-issue-agent.yml');
  assert.equal(config.labels.blocked, 'pi:blocked');
  assert.equal(issueBranch(7), 'pi/issue-7');
});

test('unknown keys and missing roles fail closed', () => {
  assert.throws(() => validateConfig({ ...raw(), surprise: 1 }), /surprise/);
  const noLabel = raw(); delete noLabel.labels.running;
  assert.throws(() => validateConfig(noLabel), /labels\.running/);
  const badWorkflow = raw(); badWorkflow.workflows.reviewer = '../x.yml';
  assert.throws(() => validateConfig(badWorkflow), /workflows\.reviewer/);
  assert.throws(() => parseConfigText('{'), /not valid JSON/);
});

test('legacy v1 config without blocked label remains loadable', () => {
  const legacy = raw();
  delete legacy.labels.blocked;
  const config = validateConfig(legacy);
  assert.equal(config.labels.blocked, undefined);
});

test('commands are fixed argv, never shell strings', () => {
  const bad = raw(); bad.checks.final[1] = { name: 'x', command: 'git', args: ['diff'], shell: 'rm -rf /' };
  assert.throws(() => validateConfig(bad));
});

test('branch parsing is strict by default and derived from the configured prefix', () => {
  assert.equal(parseIssueBranch('pi/issue-42'), 42);
  assert.equal(parseIssueBranch('pi/issue-042'), null);
  assert.equal(parseIssueBranch('pi/issue-042', { strict: false }), 42);
  assert.equal(parseIssueBranch('feature/x'), null);
  assert.deepEqual(parseCheckpointRef('pi/issue-42-checkpoint'), parseCheckpointRef('pi/issue-42-checkpoint'));
});

test('the process cwd is never searched for config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.writeFileSync(path.join(dir, '.agent-harness.json'), '{}');
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.notEqual(locateConfigFile({}, path.join(cwd, 'scripts/pi-common')), path.join(dir, '.agent-harness.json'));
  } finally { process.chdir(cwd); }
  assert.equal(locateConfigFile({ [CONFIG_ENV]: '/x/y.json' }), '/x/y.json');
});

test('file-list argument tokens expand without a shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  for (const name of ['b.test.mjs', 'a.test.mjs', 'skip.txt']) fs.writeFileSync(path.join(dir, 'tests', name), '');
  const spec = projectConfig().checks.profiles.node_tests;
  assert.deepEqual(expandCommand(spec, dir), { command: 'node', args: ['--test', 'tests/a.test.mjs', 'tests/b.test.mjs'] });
});

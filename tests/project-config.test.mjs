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
  assert.equal(config.labels.triageReady, 'triage:ready');
  assert.deepEqual(config.checks.packageRoots, { canonicalRoots: ['src'], allowDuplicatePackages: [] });
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

test('model endpoint and catalog are project data validated strictly', () => {
  assert.equal(projectConfig().model.choices.qwen.id, 'Qwen3.8-Flash-Next-NVFP4');
  const noModel = raw(); delete noModel.model;
  assert.equal(validateConfig(noModel).model, null);
  const badUrl = raw(); badUrl.model.baseUrl = 'file:///etc/passwd';
  assert.throws(() => validateConfig(badUrl), /model\.baseUrl/);
  const empty = raw(); empty.model.choices = {};
  assert.throws(() => validateConfig(empty), /model\.choices/);
  const extra = raw(); extra.model.choices.qwen.host = 'nano';
  assert.throws(() => validateConfig(extra), /model\.choices\.qwen\.host/);
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

test('package-root policy has an explicit allow-list escape hatch and rejects unknown settings', () => {
  const configured = raw();
  configured.checks.packageRoots.allowDuplicatePackages = ['generated_api'];
  assert.deepEqual(
    validateConfig(configured).checks.packageRoots.allowDuplicatePackages,
    ['generated_api'],
  );

  const invalid = raw();
  invalid.checks.packageRoots.unexpected = true;
  assert.throws(() => validateConfig(invalid), /checks\.packageRoots\.unexpected/);
});

test('package-root canonical roots reject unsafe paths and typos when validated against the checkout', () => {
  for (const badRoot of ['../src', '/tmp/src', 'src/../src']) {
    const configured = raw();
    configured.checks.packageRoots.canonicalRoots = [badRoot];
    assert.throws(() => validateConfig(configured), /must be a relative directory path/);
  }

  const typo = raw();
  typo.checks.packageRoots.canonicalRoots = ['scr'];
  assert.throws(
    () => validateConfig(typo, { root: process.cwd() }),
    /does not identify an existing directory: scr/,
  );
});


test('swift is an explicit catalog model and the versioned default', () => {
  const choices = projectConfig().model.choices;
  assert.equal(choices.swift.id, 'swift-1.5-qwen3.8-flash-next');
  assert.equal(choices.qwen.id, 'Qwen3.8-Flash-Next-NVFP4');
  assert.equal(choices.laguna.id, 'laguna-s-2.1-gguf');
  assert.equal(fs.readFileSync('.pi/default-model', 'utf8').trim(), 'swift');
});

test('every manually selectable model workflow offers exactly default plus the catalog', () => {
  const expected = ['default', ...Object.keys(projectConfig().model.choices)].sort();
  const files = fs.readdirSync('.github/workflows').filter(name => /^pi-.*\.yml$/.test(name));
  let checked = 0;
  for (const name of files) {
    const text = fs.readFileSync(path.join('.github/workflows', name), 'utf8');
    const block = text.match(/\n {6}model:\n(?: {8}.*\n)+/);
    if (!block) continue;
    const options = [...block[0].matchAll(/\n {10}- ([a-z0-9._-]+)/g)].map(match => match[1]).sort();
    assert.deepEqual(options, expected, `${name} model choices drifted from .agent-harness.json`);
    checked += 1;
  }
  assert.equal(checked, 6, 'expected six Pi workflows with a manual model choice');
});

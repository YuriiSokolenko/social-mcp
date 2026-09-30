import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runRuffCheck } from '../scripts/pi-common/product-checks.mjs';

function fixture(t, { semanticFailure = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'product-checks-'));
  const root = path.join(parent, 'checkout');
  const bin = path.join(parent, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(parent, '.ruff.toml'), '[lint]\nselect = ["EXE", "I", "RUF"]\n');
  fs.writeFileSync(path.join(root, 'pyproject.toml'), [
    '[tool.ruff]',
    'target-version = "py312"',
    '',
    '[tool.ruff.lint]',
    'select = ["E4", "E7", "E9", "F"]',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'sample.py'), 'import os\n');
  const calls = path.join(parent, 'ruff-calls.jsonl');
  const executable = path.join(bin, 'ruff');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RUFF_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('--fix')) {
  fs.writeFileSync('sample.py', 'print("fixed by shared safe fixer")\\n');
} else if (process.env.RUFF_SEMANTIC_FAILURE === 'true') {
  process.stdout.write(JSON.stringify([{
    filename: 'sample.py',
    location: { row: 3, column: 4 },
    code: 'F821',
    message: 'undefined name',
  }]));
  process.exitCode = 1;
} else {
  process.stdout.write('[]');
}
`);
  fs.chmodSync(executable, 0o755);
  const originalPath = process.env.PATH;
  const originalCalls = process.env.RUFF_CALLS;
  const originalFailure = process.env.RUFF_SEMANTIC_FAILURE;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  process.env.RUFF_CALLS = calls;
  if (semanticFailure) process.env.RUFF_SEMANTIC_FAILURE = 'true';
  else delete process.env.RUFF_SEMANTIC_FAILURE;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalCalls === undefined) delete process.env.RUFF_CALLS;
    else process.env.RUFF_CALLS = originalCalls;
    if (originalFailure === undefined) delete process.env.RUFF_SEMANTIC_FAILURE;
    else process.env.RUFF_SEMANTIC_FAILURE = originalFailure;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { parent, root, calls };
}

test('Ruff uses only the repository config even when a parent config enables extra rules', t => {
  const { root, calls } = fixture(t);
  runRuffCheck(root);

  const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 2);
  for (const args of invocations) {
    assert.equal(args[args.indexOf('--config') + 1], path.join(root, 'pyproject.toml'));
    assert.ok(args.includes('.'));
  }
  assert.ok(invocations[0].includes('--fix'));
  assert.ok(invocations[1].includes('--output-format=json'));

  const repositoryConfig = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
  assert.match(repositoryConfig, /select = \["E4", "E7", "E9", "F"\]/);
  assert.doesNotMatch(repositoryConfig, /EXE|\bI\b|RUF/);
});

test('the shared validation safe-fix pass runs before the authoritative lint result', t => {
  const { root } = fixture(t);
  runRuffCheck(root);
  assert.equal(fs.readFileSync(path.join(root, 'sample.py'), 'utf8'), 'print("fixed by shared safe fixer")\n');
});

test('remaining semantic Ruff failures identify location, rule, and repair type', t => {
  const { root } = fixture(t, { semanticFailure: true });
  assert.throws(() => runRuffCheck(root), error => {
    assert.match(error.message, /check: Ruff/);
    assert.match(error.message, /sample\.py:3:4: F821: undefined name/);
    assert.match(error.message, /mechanically fixable: no/);
    return true;
  });
});

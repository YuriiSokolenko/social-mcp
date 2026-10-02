import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProductChecks, runRuffCheck } from '../scripts/pi-common/product-checks.mjs';
import { duplicatePackageRootDiagnostics } from '../scripts/pi-common/package-root-check.mjs';
import { readValidationLedger } from '../scripts/pi-common/validation-ledger.mjs';

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
  fs.writeFileSync(path.join(root, 'untouched.py'), 'print("leave me alone")\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/dev', 'HEAD']);
  fs.writeFileSync(path.join(root, 'sample.py'), 'import os\n# changed\n');
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
    filename: process.env.RUFF_ABSOLUTE_DIAGNOSTIC === 'true' ? require('node:path').resolve('sample.py') : 'sample.py',
    location: { row: 3, column: 4 },
    code: 'F821',
    message: 'undefined name',
    fix: process.env.RUFF_ABSOLUTE_DIAGNOSTIC === 'true' ? { applicability: 'unsafe' } : null,
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
  return { parent, root, calls, bin };
}

test('Ruff uses only the repository config even when a parent config enables extra rules', t => {
  const { root, calls } = fixture(t);
  runRuffCheck(root);

  const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 2);
  for (const args of invocations) {
    assert.equal(args[args.indexOf('--config') + 1], path.join(fs.realpathSync(root), 'pyproject.toml'));
  }
  assert.ok(invocations[0].includes('--fix'));
  assert.ok(invocations[0].includes('sample.py'));
  assert.ok(!invocations[0].includes('untouched.py'));
  assert.ok(invocations[1].includes('.'));
  assert.ok(invocations[1].includes('--output-format=json'));

  const repositoryConfig = fs.readFileSync(new URL('../pyproject.toml', import.meta.url), 'utf8');
  assert.match(repositoryConfig, /select = \["E4", "E7", "E9", "F"\]/);
  assert.doesNotMatch(repositoryConfig.match(/^select = .*$/m)?.[0] ?? '', /EXE|\bI\b|RUF/);
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
    assert.match(error.message, /no automatic fix available/);
    return true;
  });
});

test('a real Ruff run ignores a conflicting config in the checkout', t => {
  if (spawnSync('ruff', ['--version']).status !== 0) return t.skip('ruff is not installed');
  const realRuff = execFileSync('which', ['ruff'], { encoding: 'utf8' }).trim();
  const { root } = fixture(t);
  process.env.PATH = `${path.dirname(realRuff)}${path.delimiter}${process.env.PATH}`;
  fs.writeFileSync(path.join(root, '.ruff.toml'), '[lint]\nselect = ["I"]\n');
  fs.writeFileSync(path.join(root, 'sample.py'), 'import sys\nimport os\nprint(os.name, sys.version)\n');
  runRuffCheck(root);
  assert.match(fs.readFileSync(path.join(root, 'sample.py'), 'utf8'), /^import sys\nimport os\n/);
});

test('Ruff diagnostics report unsafe fixes and paths relative to the checkout', t => {
  const { root } = fixture(t, { semanticFailure: true });
  process.env.RUFF_ABSOLUTE_DIAGNOSTIC = 'true';
  t.after(() => { delete process.env.RUFF_ABSOLUTE_DIAGNOSTIC; });
  assert.throws(() => runRuffCheck(root), error => {
    assert.match(error.message, /ruff: sample\.py:3:4: F821/);
    assert.match(error.message, /unsafe fix available/);
    assert.doesNotMatch(error.message, new RegExp(root));
    return true;
  });
});

test('successful product checks preserve pytest output', t => {
  const { root, bin } = fixture(t);
  const pytest = path.join(bin, 'pytest');
  fs.writeFileSync(pytest, '#!/bin/sh\nprintf "561 passed, 3 skipped\\n"\n');
  fs.chmodSync(pytest, 0o755);
  const output = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { runProductChecks } from ${JSON.stringify(new URL('../scripts/pi-common/product-checks.mjs', import.meta.url).href)}; runProductChecks({ cwd: ${JSON.stringify(root)} });`,
  ], { encoding: 'utf8', env: process.env });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /561 passed, 3 skipped/);
});

test('failed product checks retain the beginning and end of long output', t => {
  const { root, bin } = fixture(t);
  const pytest = path.join(bin, 'pytest');
  fs.writeFileSync(pytest, '#!/bin/sh\necho FIRST_FAILURE\nseq 1 80\necho LAST_FAILURE\nexit 1\n');
  fs.chmodSync(pytest, 0o755);
  assert.throws(() => runProductChecks({ cwd: root }), error => {
    assert.match(error.message, /FIRST_FAILURE/);
    assert.match(error.message, /LAST_FAILURE/);
    return true;
  });
});

test('a full passing run of checks.final records one pass entry per step in the validation ledger', t => {
  const { root, bin } = fixture(t);
  const pytest = path.join(bin, 'pytest');
  fs.writeFileSync(pytest, '#!/bin/sh\nprintf "561 passed, 3 skipped\\n"\n');
  fs.chmodSync(pytest, 0o755);
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'ledger.jsonl');
  runProductChecks({ cwd: root, ledgerPath });
  const { records } = readValidationLedger(ledgerPath);
  assert.deepEqual(records.map(r => [r.kind, r.status, r.source]), [
    ['package_roots', 'pass', 'checks_final'],
    ['ruff', 'pass', 'checks_final'],
    ['git_diff_check', 'pass', 'checks_final'],
    ['pytest', 'pass', 'checks_final'],
    ['checks_final', 'pass', 'checks_final_complete'],
  ]);
  // Unspecified backend defaults to 'pi', the only backend that existed before
  // this parameter was added.
  assert.ok(records.every(r => r.backend === 'pi'));
});

test('checks.final records carry the actual backend, not a hardcoded one, so a mini-swe implementer run is not misattributed to Pi', t => {
  const { root, bin } = fixture(t);
  const pytest = path.join(bin, 'pytest');
  fs.writeFileSync(pytest, '#!/bin/sh\nprintf "561 passed, 3 skipped\\n"\n');
  fs.chmodSync(pytest, 0o755);
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'ledger.jsonl');
  runProductChecks({ cwd: root, ledgerPath, backend: 'mini-swe' });
  const { records } = readValidationLedger(ledgerPath);
  assert.ok(records.length > 0);
  assert.ok(records.every(r => r.backend === 'mini-swe'), 'every record, including the completion marker, must carry the real backend');
});

test('a mid-pipeline checks.final failure records the failing step and not_run for every step after it', t => {
  const { root } = fixture(t, { semanticFailure: true });
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'ledger.jsonl');
  assert.throws(() => runProductChecks({ cwd: root, ledgerPath }));
  const { records } = readValidationLedger(ledgerPath);
  assert.deepEqual(records.map(r => [r.kind, r.status]), [
    ['package_roots', 'pass'],
    ['ruff', 'fail'],
    ['git_diff_check', 'not_run'],
    ['pytest', 'not_run'],
  ]);
  // A failed/interrupted pipeline must never record the completion marker.
  assert.ok(!records.some(r => r.source === 'checks_final_complete'));
});

test('missing Ruff is reported as a check infrastructure failure', t => {
  const { root } = fixture(t);
  const originalPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    assert.throws(() => runRuffCheck(root), /check: ruff could not run:.*ENOENT/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('product checks reject a top-level Python package that duplicates a canonical src-layout package', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'src', 'demo_pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'demo_pkg', '__init__.py'), '');
  fs.mkdirSync(path.join(root, 'demo_pkg'));
  fs.writeFileSync(path.join(root, 'demo_pkg', '__init__.py'), '');

  assert.throws(() => runProductChecks({ cwd: root }), error => {
    assert.match(error.message, /DuplicatePackageRoot/);
    assert.match(error.message, /demo_pkg\//);
    assert.match(error.message, /src\/demo_pkg\//);
    assert.match(error.message, /checks\.packageRoots\.allowDuplicatePackages/);
    return true;
  });
});

test('package-root guard ignores unrelated top-level directories and supports intentional duplicate roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-roots-'));
  try {
    fs.mkdirSync(path.join(root, 'src', 'demo_pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'demo_pkg', '__init__.py'), '');
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools', 'helper.py'), '');
    assert.deepEqual(
      duplicatePackageRootDiagnostics(root, { canonicalRoots: ['src'], allowDuplicatePackages: [] }),
      [],
    );

    fs.mkdirSync(path.join(root, 'demo_pkg', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'demo_pkg', 'node_modules', 'foreign.py'), '');
    assert.deepEqual(
      duplicatePackageRootDiagnostics(root, { canonicalRoots: ['src'], allowDuplicatePackages: [] }),
      [],
    );

    fs.writeFileSync(path.join(root, 'demo_pkg', '__init__.py'), '');
    assert.equal(
      duplicatePackageRootDiagnostics(root, { canonicalRoots: ['src'], allowDuplicatePackages: [] }).length,
      1,
    );
    assert.deepEqual(
      duplicatePackageRootDiagnostics(root, { canonicalRoots: ['src'], allowDuplicatePackages: ['demo_pkg'] }),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

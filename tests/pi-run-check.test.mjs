import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ProgressController, actionRequiredToolNames } from '../scripts/pi-common/progress-controller.mjs';
import { runCheck, checkMetricRecord, CHECK_KINDS } from '../scripts/pi-common/run-check.mjs';
import { ruffArgs } from '../scripts/pi-common/ruff-spec.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';

function worktree(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run-check-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function fakeBin(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const pythonBin = (() => {
  try {
    if (fs.existsSync('/usr/bin/python3')) return '/usr/bin/python3';
    const dir = process.env.PATH.split(path.delimiter).find(p => fs.existsSync(path.join(p, 'python3')));
    return dir ? path.join(dir, 'python3') : null;
  } catch {
    return null;
  }
})();
const hasPython = Boolean(pythonBin);

const directSandbox = (_root, spec) => spec;
const directOptions = (options = {}) => ({ ...options, sandboxFactory: directSandbox });

function hasCommand(name) {
  try {
    return process.env.PATH.split(path.delimiter).some(dir => fs.existsSync(path.join(dir, name)));
  } catch {
    return false;
  }
}

const hasRealSandbox = process.platform === 'linux'
  ? hasCommand('bwrap')
  : process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

test('python_compile passes on valid source and reports a syntax error with file/line', { skip: !hasPython }, async () => {
  const dir = worktree();
  fs.writeFileSync(path.join(dir, 'ok.py'), 'x = 1\n');
  fs.writeFileSync(path.join(dir, 'bad.py'), 'def (\n');
  const pass = await runCheck(dir, { kind: 'python_compile', paths: ['ok.py'] }, directOptions({ bins: { python: pythonBin } }));
  assert.equal(pass.status, 'pass');
  assert.equal(fs.existsSync(path.join(dir, '__pycache__')), false);
  const fail = await runCheck(dir, { kind: 'python_compile', paths: ['bad.py'] }, directOptions({ bins: { python: pythonBin } }));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.diagnostics[0].file, 'bad.py');
  assert.equal(fail.diagnostics[0].line, 1);
  assert.equal(fail.diagnostics[0].code, 'SyntaxError');
  assert.ok(fail.diagnostics[0].message.length > 0);
});

test('ruff pass and parsed failure use the fixed shared argv', async () => {
  const dir = worktree({ 'a.py': 'import os\n' });
  const argvLog = path.join(dir, 'argv.txt');
  const json = JSON.stringify([{ filename: path.join(fs.realpathSync(dir), 'a.py'), code: 'F401', message: '`os` imported but unused', location: { row: 1, column: 8 } }]);
  const ruff = fakeBin(dir, 'ruff', `echo "$@" > ${argvLog}\nif [ "$FAIL" = 1 ]; then :; fi\necho '${json}'\nexit 1`);
  const fail = await runCheck(dir, { kind: 'ruff', paths: ['a.py'] }, directOptions({ bins: { ruff } }));
  assert.equal(fail.status, 'fail');
  assert.deepEqual(fail.diagnostics, [{ file: 'a.py', line: 1, column: 8, code: 'F401', message: '`os` imported but unused' }]);
  assert.equal(fail.summary, '1 Ruff violation(s)');
  // Same base argv as the authoritative validator, only the output format differs.
  assert.equal(fs.readFileSync(argvLog, 'utf8').trim(), ruffArgs(dir, ['a.py'], { json: true }).join(' '));

  const passBin = fakeBin(dir, 'ruff-ok', 'echo "[]"\nexit 0');
  const pass = await runCheck(dir, { kind: 'ruff', paths: ['a.py'] }, directOptions({ bins: { ruff: passBin } }));
  assert.equal(pass.status, 'pass');
  assert.deepEqual(pass.diagnostics, []);
});

test('focused and authoritative Ruff share the repository config builder', () => {
  const dir = worktree({ 'pyproject.toml': '[tool.ruff]\n' });
  assert.deepEqual(ruffArgs(dir, ['.'], { json: true }), ['check', '--output-format=json', '--config', path.join(fs.realpathSync(dir), 'pyproject.toml'), '.']);
  const productChecks = fs.readFileSync(new URL('../scripts/pi-common/product-checks.mjs', import.meta.url), 'utf8');
  assert.match(productChecks, /ruffArgs\(root, \['\.'\], \{ json: true \}\)/);
});

test('pytest pass and failing-test diagnostics with node id, line and message', async () => {
  const dir = worktree({ 'tests/test_bar.py': 'def test_a():\n    assert 3 == 2\n' });
  const failOut = [
    'F',
    '=================================== FAILURES ===================================',
    '____________________________________ test_a ____________________________________',
    'tests/test_bar.py:2: in test_a',
    '    assert 3 == 2',
    'E   assert 3 == 2',
    '=========================== short test summary info ============================',
    'FAILED tests/test_bar.py::test_a - assert 3 == 2',
    '1 failed, 4 passed in 0.12s',
  ].join('\n');
  const bad = fakeBin(dir, 'pytest-bad', `cat <<'EOT'\n${failOut}\nEOT\nexit 1`);
  const fail = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_bar.py::test_a'] }, directOptions({ bins: { pytest: bad } }));
  assert.equal(fail.status, 'fail');
  assert.equal(fail.summary, '1 failed, 4 passed in 0.12s');
  assert.equal(fail.diagnostics[0].file, 'tests/test_bar.py');
  assert.equal(fail.diagnostics[0].line, 2);
  assert.match(fail.diagnostics[0].message, /test_a: assert 3 == 2/);
  assert.match(fail.stdout_tail, /short test summary/);

  const good = fakeBin(dir, 'pytest-ok', 'echo "5 passed in 0.1s"\nexit 0');
  const pass = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_bar.py'] }, directOptions({ bins: { pytest: good } }));
  assert.equal(pass.status, 'pass');
  assert.equal(pass.summary, '5 passed in 0.1s');
});

test('timeout kills the whole subprocess tree', async () => {
  const dir = worktree({ 'tests/test_slow.py': '' });
  const pidFile = path.join(dir, 'grandchild.pid');
  const slow = fakeBin(dir, 'pytest-slow', `sleep 30 &\necho $! > ${pidFile}\nwait`);
  const result = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_slow.py'] }, directOptions({ bins: { pytest: slow }, timeoutMs: 1500 }));
  assert.equal(result.status, 'timeout');
  assert.match(result.summary, /process tree killed/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('paths outside the worktree, traversal, symlink escapes and option-like paths are rejected', async () => {
  const dir = worktree({ 'ok.py': '' });
  const outside = worktree({ 'secret.py': '' });
  fs.symlinkSync(outside, path.join(dir, 'link'));
  for (const bad of ['../x.py', outside, 'link/secret.py', '--help', '-x.py', 'missing.py']) {
    const result = await runCheck(dir, { kind: 'python_compile', paths: [bad] });
    assert.equal(result.status, 'invalid', bad);
    assert.equal(result.diagnostics.length, 0);
  }
  const pytest = await runCheck(dir, { kind: 'pytest', targets: ['../x.py::t'] });
  assert.equal(pytest.status, 'invalid');
});

test('no arbitrary command is expressible through the public contract', async () => {
  const dir = worktree({ 'ok.py': '' });
  assert.deepEqual(CHECK_KINDS, ['python_compile', 'ruff', 'pytest', 'profile']);
  for (const request of [
    { kind: 'shell', command: 'id' },
    { kind: 'ruff', paths: ['ok.py'], command: 'id' },
    { kind: 'profile', profile: 'rm -rf /' },
    { kind: 'profile', profile: '__proto__' },
    { kind: 'pytest', targets: ['ok.py'], args: ['--co'] },
    'ruff ok.py',
    null,
  ]) {
    const result = await runCheck(dir, request);
    assert.equal(result.status, 'invalid', JSON.stringify(request));
  }
});

test('output is bounded deterministically and secrets are not inherited', async () => {
  const dir = worktree({ 'tests/test_big.py': '' });
  const big = fakeBin(dir, 'pytest-big', 'i=0\nwhile [ $i -lt 2000 ]; do echo "line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done\necho "SECRET=$GITHUB_TOKEN" >&2\nexit 1');
  const result = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_big.py'] },
    directOptions({ bins: { pytest: big }, env: { ...process.env, GITHUB_TOKEN: 'ghp_topsecret' } }));
  assert.equal(result.truncated, true);
  assert.ok(result.stdout_tail.length <= 3000);
  assert.match(result.stdout_tail, /line 1999/);
  assert.equal(result.stderr_tail.trim(), 'SECRET=');
  assert.ok(result.diagnostics.length <= 20);
});

test('output beyond four MiB retains the final failure, not the first chunk', async () => {
  const dir = worktree({ 'tests/test_big.py': '' });
  const big = fakeBin(dir, 'pytest-huge', 'head -c 4500000 /dev/zero | tr "\\000" x\nprintf "\\nFINAL_TRACEBACK\\n"\nexit 1');
  const result = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_big.py'] }, directOptions({ bins: { pytest: big } }));
  assert.equal(result.status, 'fail');
  assert.equal(result.truncated, true);
  assert.match(result.stdout_tail, /FINAL_TRACEBACK/);
  assert.ok(result.stdout_tail.length <= 3000);
});

test('check subprocess cannot use the network or read home credentials', { skip: !hasRealSandbox }, async () => {
  const dir = worktree({ 'tests/test_guard.py': '' });
  const marker = path.join(os.homedir(), '.pi-run-check-secret-test');
  fs.writeFileSync(marker, 'secret');
  try {
    const probe = fakeBin(dir, 'pytest-probe', `python3 -c 'import pathlib,socket; p=pathlib.Path(${JSON.stringify(marker)}); print("secret=" + str(p.exists())); s=socket.socket(); print("network=" + str(s.connect_ex(("127.0.0.1", 1))))'`);
    const result = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_guard.py'] }, { bins: { pytest: probe } });
    assert.equal(result.status, 'pass');
    assert.match(result.stdout_tail, /secret=False/);
    assert.match(result.stdout_tail, /network=[1-9][0-9]*/);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('missing sandbox binary reports the sandbox dependency, not the check command', async () => {
  const dir = worktree({ 'ok.py': 'x = 1\n' });
  const result = await runCheck(
    dir,
    { kind: 'python_compile', paths: ['ok.py'] },
    { sandboxFactory: () => ({ command: '/nonexistent/pi-check-sandbox', args: [] }) },
  );
  assert.equal(result.status, 'fail');
  assert.match(result.summary, /Could not start check sandbox \/nonexistent\/pi-check-sandbox: ENOENT/);
});

test('runner images declare the focused-check sandbox dependency', () => {
  for (const dockerfile of ['worker.Dockerfile', 'worker-general.Dockerfile']) {
    const source = fs.readFileSync(new URL(`../infra/github-runner-autoscaler/${dockerfile}`, import.meta.url), 'utf8');
    assert.match(source, /apt-get install[\s\S]*\bbubblewrap\b/, dockerfile);
  }
});

test('failed check returns usable diagnostics even when output is unparsed', async () => {
  const dir = worktree({ 'tests/test_x.py': '' });
  const odd = fakeBin(dir, 'pytest-odd', 'echo "collected 0 items"\necho "ImportError: no module foo" >&2\nexit 2');
  const result = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_x.py'] }, directOptions({ bins: { pytest: odd } }));
  assert.equal(result.status, 'fail');
  assert.equal(result.exit_code, 2);
  assert.match(result.stderr_tail, /ImportError/);
  assert.match(result.summary, /exit code 2/);
});

test('named node_tests profile runs a fixed argv', async () => {
  const dir = worktree({ 'tests/a.test.mjs': "import test from 'node:test'; test('t', () => {});\n" });
  const result = await runCheck(dir, { kind: 'profile', profile: 'node_tests' }, directOptions());
  assert.equal(result.status, 'pass');
  assert.equal(result.profile, 'node_tests');
});

test('missing binary is a fail result, not a thrown error', async () => {
  const dir = worktree({ 'a.py': '' });
  const result = await runCheck(dir, { kind: 'ruff', paths: ['a.py'] }, directOptions({ bins: { ruff: '/nonexistent/ruff' } }));
  assert.equal(result.status, 'fail');
  assert.match(result.summary, /Could not start/);
});

test('metric record carries no raw output', () => {
  const record = checkMetricRecord({ kind: 'ruff', status: 'fail', duration_ms: 5, truncated: false, diagnostics: [{}, {}], stdout_tail: 'secret' },
    { backend: 'pi', stage: 'implementer' });
  assert.deepEqual(record, { backend: 'pi', stage: 'implementer', kind: 'ruff', profile: null, status: 'fail', duration_ms: 5, truncated: false, diagnostics: 2 });
});

// --- progress-controller integration -------------------------------------------------------

const implementer = () => new ProgressController({
  ...stageConfig('implementer'),
  requireComplexity: false,
  productiveProgress: { ...stageConfig('implementer').productiveProgress, startState: 'action_required' },
}, {});

test('edit -> run_check(fail) -> edit -> run_check(pass) -> submit is a valid productive flow', () => {
  const c = implementer();
  c.onTurnStart(0);
  assert.equal(c.checkToolCall('run_check', { kind: 'ruff', paths: ['a.py'] })?.block, true, 'no permit before any mutation');
  assert.equal(c.checkToolCall('safe_edit', { path: 'a.py' }), undefined);
  c.onToolExecutionEnd('safe_edit', false);
  assert.equal(c.verificationPermitted(), true);
  c.onTurnStart(1);
  assert.equal(c.checkToolCall('run_check', { kind: 'ruff', paths: ['a.py'] }), undefined);
  c.onToolExecutionEnd('run_check', false); // a failing check is a normal (non-error) result
  assert.equal(c.productiveProgressState(), 'action_required');
  assert.equal(c.turnMadeProgress, false, 'a check is evidence, not progress');
  assert.equal(c.verificationPermitted(), false);
  assert.equal(c.checkToolCall('run_check', { kind: 'ruff', paths: ['a.py', 'b.py'] })?.block, true, 'no escape hatch without a new mutation');
  assert.equal(c.checkToolCall('safe_edit', { path: 'a.py', n: 2 }), undefined);
  c.onToolExecutionEnd('safe_edit', false);
  assert.equal(c.checkToolCall('run_check', { kind: 'ruff', paths: ['a.py'] }), undefined);
  c.onToolExecutionEnd('run_check', false);
  assert.equal(c.checkToolCall('submit_result', {}), undefined);
});

test('repeated identical failing check without a state change is blocked by the repeat guard', () => {
  const c = new ProgressController({ maxTurns: 100, repeatThreshold: 2, requireComplexity: false }, {});
  const input = { kind: 'pytest', targets: ['tests/test_a.py'] };
  assert.equal(c.checkToolCall('run_check', input), undefined);
  assert.equal(c.checkToolCall('run_check', input), undefined);
  assert.equal(c.checkToolCall('run_check', input)?.block, true);
});

test('run_check is exposed in the action-required surface only while a permit exists', () => {
  const active = ['read', 'safe_edit', 'run_check', 'submit_result', 'bash'];
  const cfg = stageConfig('implementer').productiveProgress;
  const base = { actionTools: cfg.actionTools, controlTools: cfg.controlTools, blockerTool: cfg.blockerTool };
  assert.ok(!actionRequiredToolNames(active, base).includes('run_check'));
  assert.ok(actionRequiredToolNames(active, { ...base, verificationTools: ['run_check'] }).includes('run_check'));
  assert.ok(!actionRequiredToolNames(active, { ...base, verificationTools: ['run_check'] }).includes('bash'));
});

test('Pi exposes run_check without enabling unrestricted bash, and the core stays backend-neutral', () => {
  const runtime = fs.readFileSync(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /name: 'run_check'/);
  assert.equal(stageConfig('implementer').boundedDirectBash, true);
  const core = fs.readFileSync(new URL('../scripts/pi-common/run-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /typebox|pi-agent-runtime|registerTool/);
});

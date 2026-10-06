import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ProgressController, actionRequiredToolNames } from '../scripts/pi-common/progress-controller.mjs';
import { runCheck, checkMetricRecord, sandboxPreflight, CHECK_KINDS, CHECK_STATUSES } from '../scripts/pi-common/run-check.mjs';
import { ruffArgs } from '../scripts/pi-common/ruff-spec.mjs';
import { stageConfig } from '../scripts/pi-common/stage-config.mjs';
import { createDockerSandboxBackend } from '../scripts/pi-common/run-check-docker-backend.mjs';

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

const hasRealSandbox = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

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

test('focused validation fails early when a top-level package duplicates the configured src-layout package', async t => {
  const dir = worktree({
    'src/demo_pkg/__init__.py': '',
    'demo_pkg/__init__.py': '',
    'probe.py': 'answer = 42\\n',
    'tests/a.test.mjs': "import test from 'node:test'; test('ok', () => {});\n",
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await runCheck(
    dir,
    { kind: 'python_compile', paths: ['probe.py'] },
    directOptions({ bins: { python: pythonBin ?? 'python3' } }),
  );
  assert.equal(result.status, 'fail');
  assert.equal(result.exit_code, null);
  assert.equal(result.diagnostics[0].code, 'DuplicatePackageRoot');
  assert.equal(result.diagnostics[0].file, 'demo_pkg/');
  assert.match(result.diagnostics[0].message, /src\/demo_pkg\//);

  const nodeProfile = await runCheck(dir, { kind: 'profile', profile: 'node_tests' }, directOptions());
  assert.equal(nodeProfile.status, 'pass');
});

test('newly created smoke file compiles with a worktree-absolute path', { skip: !hasPython }, async t => {
  const dir = worktree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'brick_smoke.py'), 'answer = 42\n');
  for (const target of ['brick_smoke.py', path.join(dir, 'brick_smoke.py'), path.join(fs.realpathSync(dir), 'brick_smoke.py')]) {
    const result = await runCheck(dir, { kind: 'python_compile', paths: [target] }, directOptions({ bins: { python: pythonBin } }));
    assert.equal(result.status, 'pass', target);
    assert.equal(result.summary, 'Compiled cleanly');
  }
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

test('Docker backend sends structured check fields only and strips runner secrets from its environment', async () => {
  const dir = worktree({ 'ok.py': 'x = 1\n' });
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ exitCode: 0, durationMs: 4, stdout: '', stderr: '' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const backend = createDockerSandboxBackend({
      PI_RUN_CHECK_EXECUTOR_URL: 'http://127.0.0.1:17343',
      RUN_CHECK_EXECUTOR_TOKEN: 'a'.repeat(64),
      RUNNER_NAME: 'n150-pi-eph-test',
    });
    const result = await runCheck(dir, { kind: 'python_compile', paths: ['ok.py'] }, {
      backend,
      env: {
        PATH: '/bin',
        LANG: 'C.UTF-8',
        GITHUB_TOKEN: 'must-not-escape',
        PI_TRUSTED_ACCEPTANCE_TARGETS: 'social_mcp.diagnostics.smoke_lru',
        PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS: 'social_mcp.diagnostics.smoke_intervals',
      },
    });
    assert.equal(result.status, 'pass');
    assert.equal(captured.url, 'http://127.0.0.1:17343/v1/run-check');
    assert.equal(captured.body.runner_name, 'n150-pi-eph-test');
    assert.deepEqual(captured.body.params, { kind: 'python_compile', paths: ['ok.py'] });
    assert.deepEqual(Object.keys(captured.body).sort(), ['env', 'params', 'root', 'runner_name', 'timeout_ms']);
    assert.equal(captured.body.env.GITHUB_TOKEN, undefined);
    assert.equal(captured.body.env.PI_TRUSTED_ACCEPTANCE_TARGETS, 'social_mcp.diagnostics.smoke_lru');
    assert.equal(captured.body.env.PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS, 'social_mcp.diagnostics.smoke_intervals');
    assert.equal(captured.body.docker_args, undefined);
    assert.equal(captured.body.mounts, undefined);
    assert.equal(captured.body.command, undefined);
    assert.equal(captured.options.headers.authorization, `Bearer ${'a'.repeat(64)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Docker backend startup errors become infra_error rather than code failures', async () => {
  const dir = worktree({ 'ok.py': 'x = 1\n' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'DOCKER_CREATE_FAILED', message: 'sandbox container create failed' } }), {
    status: 503, headers: { 'content-type': 'application/json' },
  });
  try {
    const result = await runCheck(dir, { kind: 'python_compile', paths: ['ok.py'] }, {
      backend: createDockerSandboxBackend({ RUN_CHECK_EXECUTOR_TOKEN: 'b'.repeat(64), RUNNER_NAME: 'n150-pi-eph-test' }),
    });
    assert.equal(result.status, 'infra_error');
    assert.equal(result.infrastructure.component, 'sandbox');
    assert.equal(result.infrastructure.code, 'DOCKER_CREATE_FAILED');
    assert.match(result.summary, /sandbox container create failed/);
  } finally {
    globalThis.fetch = originalFetch;
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

test('output beyond four MiB keeps a bounded failure tail and the complete artifact', async () => {
  const dir = worktree({ 'tests/test_big.py': '' });
  const diagnosticsFile = path.join(dir, 'diagnostics.jsonl');
  const big = fakeBin(dir, 'pytest-huge', 'echo FIRST_DIAGNOSTIC\nhead -c 4500000 /dev/zero | tr "\\000" x\nprintf "\\nFINAL_TRACEBACK\\n"\nexit 1');
  const result = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_big.py'] }, directOptions({
    bins: { pytest: big },
    env: { ...process.env, PI_DIAGNOSTICS_FILE: diagnosticsFile },
  }));
  assert.equal(result.status, 'fail');
  assert.equal(result.truncated, true);
  assert.match(result.stdout_tail, /FINAL_TRACEBACK/);
  assert.ok(result.stdout_tail.length <= 3000);
  const artifact = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.match(artifact, /FIRST_DIAGNOSTIC/);
  assert.match(artifact, /FINAL_TRACEBACK/);
});

test('failed check writes complete sanitized output to the diagnostics artifact', async () => {
  const dir = worktree({ 'tests/test_big.py': '' });
  const diagnosticsFile = path.join(dir, 'diagnostics.jsonl');
  const payload = 'complete-check-detail-'.repeat(400);
  const failing = fakeBin(dir, 'pytest-diagnostic', `printf '%s\\n' '${payload}'\nprintf 'api_key=syntheticCheckSecret123\\n' >&2\nexit 1`);
  const result = await runCheck(dir, { kind: 'pytest', targets: ['tests/test_big.py'] }, directOptions({
    bins: { pytest: failing },
    env: { ...process.env, PI_DIAGNOSTICS_FILE: diagnosticsFile },
  }));
  assert.equal(result.status, 'fail');
  assert.match(result.diagnostic_ref, /diagnostics\.jsonl#check-/);
  const artifact = fs.readFileSync(diagnosticsFile, 'utf8');
  assert.match(artifact, /complete-check-detail-/);
  assert.match(artifact, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(artifact, /syntheticCheckSecret123/);
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

test('missing sandbox binary reports the sandbox dependency as an infrastructure error, not a check failure', async () => {
  const dir = worktree({ 'ok.py': 'x = 1\n' });
  const result = await runCheck(
    dir,
    { kind: 'python_compile', paths: ['ok.py'] },
    { backend: { run: async () => ({ infrastructure: { component: 'sandbox', code: 'SANDBOX_IMAGE_MISSING', command: 'docker-sandbox', message: 'sandbox image missing' } }) } },
  );
  assert.equal(result.status, 'infra_error');
  assert.match(result.summary, /INFRASTRUCTURE ERROR/);
  assert.match(result.summary, /do not look for a shell or bash workaround/);
  assert.deepEqual(result.infrastructure, { component: 'sandbox', code: 'SANDBOX_IMAGE_MISSING', command: 'docker-sandbox' });
  assert.deepEqual(result.diagnostics, []);
});

test('Docker backend failures are infrastructure errors; compiler failures stay normal failures', async () => {
  const dir = worktree({ 'ok.py': 'x = 1\n' });
  const request = { kind: 'python_compile', paths: ['ok.py'] };
  const setup = await runCheck(dir, request, { backend: { run: async () => ({ infrastructure: { component: 'sandbox', code: 'DOCKER_CREATE_FAILED', command: 'docker-sandbox', message: 'container create failed' } }) } });
  assert.equal(setup.status, 'infra_error');
  assert.equal(setup.infrastructure.component, 'sandbox');
  assert.equal(setup.infrastructure.code, 'DOCKER_CREATE_FAILED');
  const failing = await runCheck(dir, request, { backend: { run: async () => ({ exitCode: 1, durationMs: 2, stdout: JSON.stringify({ file: 'ok.py', line: 1, message: 'invalid syntax' }) }) } });
  assert.equal(failing.status, 'fail');
  assert.equal(failing.infrastructure, undefined);
});

test('a platform without any sandbox is an infrastructure error and never runs the check unsandboxed', async () => {
  const dir = worktree({ 'ok.py': 'x = 1\n' });
  const marker = path.join(dir, 'ran');
  const result = await runCheck(dir, { kind: 'ruff', paths: ['ok.py'] }, { backend: { run: async () => ({ infrastructure: { component: 'sandbox', code: 'UNAVAILABLE', command: null, message: 'executor unavailable' } }) } });
  assert.equal(result.status, 'infra_error');
  assert.equal(result.infrastructure.code, 'UNAVAILABLE');
  assert.equal(fs.existsSync(marker), false);
});

test('sandboxPreflight passes when the sandbox runs a no-op', async () => {
  const result = await sandboxPreflight({ sandboxFactory: directSandbox });
  assert.equal(result.ok, true);
  assert.ok(result.duration_ms >= 0);
});

test('Docker sandbox preflight reports executor failures as structured infrastructure blocks', async () => {
  const missing = await sandboxPreflight({ backend: { preflight: async () => ({ ok: false, status: 'infra_error', summary: 'Docker unavailable', infrastructure: { component: 'sandbox', code: 'EXECUTOR_UNAVAILABLE', command: 'trusted-run-check-executor' } }) } });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'infra_error');
  assert.deepEqual(missing.infrastructure, { component: 'sandbox', code: 'EXECUTOR_UNAVAILABLE', command: 'trusted-run-check-executor' });
});

test('sandboxPreflight succeeds through the real sandbox on this platform', { skip: !hasRealSandbox }, async () => {
  const result = await sandboxPreflight();
  assert.equal(result.ok, true, result.summary);
});

test('Pi runtime fail-closes the stage when session_start preflight fails instead of swallowing the extension error', { skip: process.platform !== 'linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preflight-runtime-'));
  try {
    const issueContext = path.join(dir, 'issue.json');
    const failureFile = path.join(dir, 'runtime-failure.json');
    const loader = path.join(dir, 'loader.mjs');
    fs.writeFileSync(issueContext, JSON.stringify({ title: 'test', body: 'test' }));
    // `typebox` is stubbed: only the session_start wiring is exercised here.
    fs.writeFileSync(loader, `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'typebox') {
          const source = 'export const Type = new Proxy({}, { get: () => (...args) => ({}) });';
          return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
    `);
    const script = `
      import assert from 'node:assert/strict';
      const handlers = new Map();
      let modelSet = false;
      let aborted = false;
      const pi = {
        on: (name, handler) => handlers.set(name, handler),
        registerTool: () => {},
        getActiveTools: () => [],
        setActiveTools: () => {},
        sendUserMessage: async () => {},
        setModel: async () => { modelSet = true; return true; },
      };
      const { default: extension } = await import(${JSON.stringify(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url).href)});
      extension(pi);
      await handlers.get('session_start')({}, { model: { provider: 'test', id: 'model', maxTokens: 32000 }, cwd: process.cwd(), abort: async () => { aborted = true; } });
      assert.equal(aborted, true, 'session_start explicitly aborts the Pi stage');
      assert.equal(modelSet, false, 'no agent budget/model work may start after a failed preflight');
      const blocked = handlers.get('before_provider_request')({ payload: { tools: [{ function: { name: 'write' } }] } });
      assert.deepEqual(blocked.tools, [], 'defensive request gate exposes no actionable tools');
      assert.equal(blocked.tool_choice, 'none');
      const failure = JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(failureFile)}, 'utf8'));
      assert.equal(failure.failure_class, 'infrastructure');
      assert.equal(failure.failure_code, 'PI_RUN_CHECK_PREFLIGHT_FAILED');
      assert.match(failure.reason, /run_check sandbox preflight failed: INFRASTRUCTURE ERROR:/);
    `;
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: '/nonexistent-pi-bin',
        PI_STAGE: 'implementer',
        PI_ISSUE: '1',
        PI_ISSUE_CONTEXT: issueContext,
        PI_RUNTIME_FAILURE_FILE: failureFile,
        GITHUB_WORKSPACE: new URL('..', import.meta.url).pathname,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /PI_RUN_CHECK_PREFLIGHT \{"stage":"implementer","ok":false/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('focused-check tools live in the dedicated sandbox image, not the agent image', () => {
  const source = fs.readFileSync(new URL('../infra/github-runner-autoscaler/run-check-sandbox.Dockerfile', import.meta.url), 'utf8');
  assert.match(source, /FROM python:3\.12/);
  assert.match(source, /USER 1001:1001/);
  assert.doesNotMatch(fs.readFileSync(new URL('../infra/github-runner-autoscaler/worker.Dockerfile', import.meta.url), 'utf8'), /bubblewrap/);
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

test('missing check binary is an infrastructure error result, not a thrown error or a code failure', async () => {
  const dir = worktree({ 'a.py': '' });
  const result = await runCheck(dir, { kind: 'ruff', paths: ['a.py'] }, directOptions({ bins: { ruff: '/nonexistent/ruff' } }));
  assert.equal(result.status, 'infra_error');
  assert.match(result.summary, /Could not start/);
  assert.equal(result.infrastructure.component, 'check_command');
});

test('metric record carries no raw output', () => {
  const record = checkMetricRecord({ kind: 'ruff', status: 'fail', duration_ms: 5, truncated: false, diagnostics: [{}, {}], stdout_tail: 'secret' },
    { backend: 'pi', stage: 'implementer' });
  assert.deepEqual(record, { backend: 'pi', stage: 'implementer', kind: 'ruff', profile: null, status: 'fail', duration_ms: 5, truncated: false, diagnostics: 2 });
});

test('metric record marks infrastructure errors so they are countable apart from check failures', () => {
  const record = checkMetricRecord({
    kind: 'pytest', status: 'infra_error', duration_ms: 1, truncated: false, diagnostics: [], stderr_tail: 'secret',
    infrastructure: { component: 'sandbox', code: 'EXECUTOR_CONFIG', command: 'trusted-run-check-executor' },
  }, { backend: 'pi', stage: 'implementer' });
  assert.equal(record.status, 'infra_error');
  assert.equal(record.infrastructure, 'sandbox');
  assert.equal(record.infrastructure_code, 'EXECUTOR_CONFIG');
  assert.equal('stderr_tail' in record, false);
});

// --- progress-controller integration -------------------------------------------------------

const implementer = () => new ProgressController({
  ...stageConfig('implementer'),
  requireComplexity: false,
  productiveProgress: { ...stageConfig('implementer').productiveProgress, startState: 'action_required' },
}, {});

test('verification lifecycle distinguishes pre-mutation, available, exhausted, and rearmed states', () => {
  const c = implementer();
  c.onTurnStart(0);
  assert.equal(c.verificationLifecycleState(), 'not_yet_available');
  assert.equal(c.verificationPermitted(), false);

  assert.equal(c.checkToolCall('safe_edit', { path: 'a.py' }), undefined);
  c.onToolExecutionEnd('safe_edit', false);
  assert.equal(c.verificationLifecycleState(), 'available');
  assert.equal(c.verificationPermitted(), true);

  assert.equal(c.checkToolCall('run_check', { kind: 'ruff', paths: ['a.py'] }), undefined);
  assert.equal(c.verificationLifecycleState(), 'exhausted', 'accepted check consumes the permit before execution');
  assert.equal(c.verificationPermitted(), false);
  c.onToolExecutionEnd('run_check', true);
  assert.equal(c.verificationLifecycleState(), 'exhausted', 'execution errors do not restore a consumed permit');

  assert.equal(c.checkToolCall('safe_edit', { path: 'a.py', n: 2 }), undefined);
  c.onToolExecutionEnd('safe_edit', false);
  assert.equal(c.verificationLifecycleState(), 'available', 'a new successful mutation rearms focused verification');
  assert.equal(c.verificationPermitted(), true);
});

test('blocked run_check does not consume an available permit', () => {
  const cfg = stageConfig('implementer');
  const c = new ProgressController({
    ...cfg,
    maxTurns: 1,
    requireComplexity: false,
    productiveProgress: { ...cfg.productiveProgress, startState: 'action_required' },
  }, {});
  c.onTurnStart(0);
  assert.equal(c.checkToolCall('safe_edit', { path: 'a.py' }), undefined);
  c.onToolExecutionEnd('safe_edit', false);
  assert.equal(c.verificationLifecycleState(), 'available');

  c.onTurnStart(1);
  const blocked = c.checkToolCall('run_check', { kind: 'ruff', paths: ['a.py'] });
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /Global execution limit reached/);
  assert.equal(c.verificationLifecycleState(), 'available');
  assert.equal(c.verificationPermitted(), true);
});

test('controller without a verification tool has no verification lifecycle', () => {
  const c = new ProgressController({ maxTurns: 100, repeatThreshold: 3, requireComplexity: false }, {});
  assert.equal(c.verificationLifecycleState(), null);
  assert.equal(c.verificationPermitted(), false);
});

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
  assert.ok(stageConfig('implementer').productiveProgress.codingSessionTools.includes('retry_last_failed_check'));
  assert.equal(stageConfig('implementer').boundedDirectBash, true);
  const core = fs.readFileSync(new URL('../scripts/pi-common/run-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /typebox|pi-agent-runtime|registerTool/);
});

test('infrastructure errors are a distinct status and no shell fallback exists in the check core or the runtime tool', () => {
  assert.deepEqual(CHECK_STATUSES, ['pass', 'fail', 'timeout', 'invalid', 'infra_error']);
  const core = fs.readFileSync(new URL('../scripts/pi-common/run-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(core, /['"`](?:\/bin\/)?(?:ba|z|da)?sh['"`]|bash -c|shell:\s*true/);
  const runtime = fs.readFileSync(new URL('../scripts/pi-agent-runtime.mjs', import.meta.url), 'utf8');
  assert.match(runtime, /status: pass\|fail\|timeout\|invalid\|infra_error/);
  assert.match(runtime, /if \(config\.productiveProgress\?\.verificationTool === 'run_check'\) \{[\s\S]*?await preflightRunCheckSandbox\(\);/);
  // Preflight must run before the response budget/model work of the session starts.
  assert.ok(runtime.indexOf('await preflightRunCheckSandbox();') < runtime.indexOf("await applyBudget('short', ctx);"));
});

test('an infra_error result is a normal tool result: it consumes the permit and grants no progress', () => {
  const c = implementer();
  c.onTurnStart(0);
  c.checkToolCall('safe_edit', { path: 'a.py' });
  c.onToolExecutionEnd('safe_edit', false);
  c.onTurnStart(1);
  assert.equal(c.checkToolCall('run_check', { kind: 'ruff', paths: ['a.py'] }), undefined);
  c.onToolExecutionEnd('run_check', false);
  assert.equal(c.turnMadeProgress, false);
  assert.equal(c.verificationPermitted(), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_CHECK_ENV_CONTRACT, runCheck, sandboxPreflight } from '../scripts/pi-common/run-check.mjs';
import { createDockerSandboxBackend } from '../scripts/pi-common/run-check-docker-backend.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.RUN_CHECK_HARNESS_ROOT = repoRoot;
process.env.RUN_CHECK_SANDBOX_IMAGE = 'n150/run-check-sandbox:0.1.0-test';
const { assertCheckEnvironmentContract, buildSandboxContainerArgs, verifySandboxContainerConfig, remapRunnerPaths, buildStagedRunCheckSpec, safeCheckEnvironment } = await import('../infra/github-runner-autoscaler/run-check-executor.mjs');

test('sandbox environment permits only validated trusted acceptance module lists', () => {
  const env = safeCheckEnvironment({
    PATH: '/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8',
    PI_TRUSTED_ACCEPTANCE_TARGETS: 'social_mcp.diagnostics.smoke_lru',
    PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS: 'social_mcp.diagnostics.smoke_intervals',
  });
  assert.equal(env.PI_TRUSTED_ACCEPTANCE_TARGETS, 'social_mcp.diagnostics.smoke_lru');
  assert.equal(env.PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS, 'social_mcp.diagnostics.smoke_intervals');
  assert.throws(
    () => safeCheckEnvironment({ PI_TRUSTED_ACCEPTANCE_TARGETS: 'social_mcp.ok;rm -rf /' }),
    /invalid PI_TRUSTED_ACCEPTANCE_TARGETS value/,
  );
  assert.throws(
    () => safeCheckEnvironment({ PI_ISSUE_CONTEXT: '/tmp/issue.json' }),
    /unsupported check environment key: PI_ISSUE_CONTEXT/,
  );
});

test('#481 producer and trusted executor share one versioned environment contract', async () => {
  assert.equal(assertCheckEnvironmentContract(RUN_CHECK_ENV_CONTRACT), true);
  assert.throws(
    () => assertCheckEnvironmentContract({ version: RUN_CHECK_ENV_CONTRACT.version, keys: RUN_CHECK_ENV_CONTRACT.keys.filter(key => key !== 'PI_TRUSTED_ACCEPTANCE_TARGETS') }),
    error => error.code === 'CHECK_ENV_CONTRACT',
  );
  assert.throws(
    () => assertCheckEnvironmentContract({ version: RUN_CHECK_ENV_CONTRACT.version - 1, keys: RUN_CHECK_ENV_CONTRACT.keys }),
    error => error.code === 'CHECK_ENV_CONTRACT',
    'a stale executor with the previous contract version is rejected even if it has the same keys',
  );

  let captured = null;
  const result = await sandboxPreflight({
    env: {
      PI_TRUSTED_ACCEPTANCE_TARGETS: 'social_mcp.diagnostics.smoke_lru',
      PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS: 'social_mcp.diagnostics.smoke_intervals',
    },
    backend: {
      async preflight(args) {
        captured = args;
        return { ok: true, duration_ms: 1 };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(captured.envContract, RUN_CHECK_ENV_CONTRACT);
  assert.equal(captured.env.PI_TRUSTED_ACCEPTANCE_TARGETS, 'social_mcp.diagnostics.smoke_lru');
  assert.equal(captured.env.PI_TRUSTED_ACCEPTANCE_BASELINE_TARGETS, 'social_mcp.diagnostics.smoke_intervals');
});

test('#481 Docker preflight fails closed when a stale executor does not echo the environment contract', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const backend = createDockerSandboxBackend({ RUN_CHECK_EXECUTOR_TOKEN: 'test-token', RUNNER_NAME: 'test-runner' });
  const args = {
    root: '/tmp/preflight',
    env: { PATH: '/bin', HOME: '/tmp', TMPDIR: '/tmp', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    envContract: RUN_CHECK_ENV_CONTRACT,
    timeoutMs: 1000,
  };

  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    duration_ms: 1,
    environment_contract: { version: RUN_CHECK_ENV_CONTRACT.version - 1, keys: RUN_CHECK_ENV_CONTRACT.keys },
  }), { status: 200 });
  const stale = await backend.preflight(args);
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 'infra_error');
  assert.equal(stale.infrastructure.code, 'CHECK_ENV_CONTRACT');
  assert.match(stale.summary, /environment contract does not match the runtime/);

  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.env_contract, RUN_CHECK_ENV_CONTRACT);
    assert.equal(body.env.PI_TRUSTED_ACCEPTANCE_TARGETS, undefined);
    return new Response(JSON.stringify({
      ok: true,
      duration_ms: 1,
      environment_contract: RUN_CHECK_ENV_CONTRACT,
    }), { status: 200 });
  };
  const current = await backend.preflight(args);
  assert.equal(current.ok, true);
});

test('runner absolute paths remap to the same relative staged targets for supported path checks', () => {
  const root = '/home/runner/work/repo';
  assert.deepEqual(remapRunnerPaths(root, { kind: 'python_compile', paths: ['src/a.py'] }), { kind: 'python_compile', paths: ['src/a.py'] });
  assert.deepEqual(remapRunnerPaths(root, { kind: 'python_compile', paths: [`${root}/src/a.py`] }), { kind: 'python_compile', paths: ['src/a.py'] });
  assert.deepEqual(remapRunnerPaths(root, { kind: 'ruff', paths: [`${root}/src/a.py`] }), { kind: 'ruff', paths: ['src/a.py'] });
  assert.deepEqual(remapRunnerPaths(root, { kind: 'pytest', targets: [`${root}/tests/test_a.py::test_one`] }), { kind: 'pytest', targets: ['tests/test_a.py::test_one'] });
  assert.throws(() => remapRunnerPaths(root, { kind: 'python_compile', paths: ['/etc/passwd'] }), /escapes the current worktree/);
});

test('executor staging seam remaps canonical runner paths then validates the staged tree', t => {
  const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-check-runner-'));
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-check-stage-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-check-outside-'));
  t.after(() => {
    fs.rmSync(canonicalRoot, { recursive: true, force: true });
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  for (const [root, name, contents] of [
    [canonicalRoot, 'src/a.py', 'answer = 42\n'], [stageRoot, 'src/a.py', 'answer = 42\n'],
    [canonicalRoot, 'tests/test_a.py', 'def test_one(): pass\n'], [stageRoot, 'tests/test_a.py', 'def test_one(): pass\n'],
  ]) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  fs.writeFileSync(path.join(outsideRoot, 'secret.py'), 'secret = True\n');
  fs.symlinkSync(path.join(outsideRoot, 'secret.py'), path.join(stageRoot, 'src/escape.py'));

  const options = { bins: { python: 'python3', ruff: 'ruff', pytest: 'pytest' } };
  const relative = buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: ['src/a.py'] }, options);
  const absolute = buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: [path.join(canonicalRoot, 'src/a.py')] }, options);
  assert.deepEqual(absolute.spec, relative.spec);
  assert.equal(absolute.spec.args.at(-1), 'src/a.py');
  assert.deepEqual(buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'ruff', paths: [path.join(canonicalRoot, 'src/a.py')] }, options).spec.args.slice(-1), ['src/a.py']);
  assert.deepEqual(buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'pytest', targets: [`${canonicalRoot}/tests/test_a.py::test_one`] }, options).spec.args.slice(-1), ['tests/test_a.py::test_one']);

  assert.throws(() => buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: [path.join(outsideRoot, 'secret.py')] }, options), /escapes the current worktree/);
  assert.throws(() => buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: ['../secret.py'] }, options), /escapes the current worktree/);
  for (const target of ['src/escape.py', `${canonicalRoot}/src/escape.py`]) {
    assert.throws(() => buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: [target] }, options), { name: 'InvalidCheck', message: /resolves outside the current worktree/ });
  }
  assert.throws(() => buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: ['src/missing.py'] }, options), /path does not exist/);
});

test('run_check sends canonical relative requests through Docker and preserves staged invalid classification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-check-root-'));
  const alias = `${root}-alias`;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'run-check-stage-'));
  fs.symlinkSync(root, alias);
  for (const dir of [root, stage]) fs.writeFileSync(path.join(dir, 'brick_smoke.py'), 'answer = 42\n');
  t.after(() => {
    fs.unlinkSync(alias);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const captured = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    captured.push(body);
    let result;
    try {
      const built = buildStagedRunCheckSpec(body.root, stage, body.params);
      result = { exitCode: 0, durationMs: 1, stdout: '', stderr: '', spec: built.spec };
    } catch (error) {
      // Match the trusted executor's classification boundary.
      result = error.name === 'InvalidCheck'
        ? { status: 'invalid', message: error.message }
        : { infrastructure: { component: 'sandbox', code: 'SANDBOX_EXECUTOR_ERROR', message: error.message } };
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const backend = createDockerSandboxBackend({ RUN_CHECK_EXECUTOR_TOKEN: 'test-token', RUNNER_NAME: 'test-runner' });
  for (const kind of ['python_compile', 'ruff', 'pytest']) {
    const field = kind === 'pytest' ? 'targets' : 'paths';
    const suffix = kind === 'pytest' ? '::test_one' : '';
    const specs = [];
    for (const target of [`brick_smoke.py${suffix}`, `${alias}/brick_smoke.py${suffix}`, `${fs.realpathSync(root)}/brick_smoke.py${suffix}`]) {
      const result = await runCheck(alias, { kind, [field]: [target] }, { backend });
      assert.equal(result.status, 'pass', target);
      const body = captured.at(-1);
      assert.deepEqual(body.params, { kind, [field]: [`brick_smoke.py${suffix}`] });
      specs.push(buildStagedRunCheckSpec(body.root, stage, body.params).spec);
    }
    assert.deepEqual(specs[0], specs[1]);
    assert.deepEqual(specs[0], specs[2]);
    for (const bad of ['/tmp/outside.py', '/etc/passwd', '../outside.py', `${alias}-sibling/outside.py`, './--help']) {
      const count = captured.length;
      const result = await runCheck(alias, { kind, [field]: [`${bad}${suffix}`] }, { backend });
      assert.equal(result.status, 'invalid', bad);
      assert.equal(result.infrastructure, undefined);
      assert.doesNotMatch(result.summary, /INFRASTRUCTURE|Do not retry/);
      assert.equal(captured.length, count, 'invalid input must not reach executor');
    }
  }
  // Runner-local validation succeeds, but the staged tree lost the target.
  fs.unlinkSync(path.join(stage, 'brick_smoke.py'));
  const missing = await runCheck(alias, { kind: 'python_compile', paths: [`${alias}/brick_smoke.py`] }, { backend });
  assert.equal(missing.status, 'invalid');
  assert.match(missing.summary, /path does not exist/);
  assert.equal(missing.infrastructure, undefined);
});

const safeContainer = () => ({
  HostConfig: {
    NetworkMode: 'none', CapDrop: ['ALL'], CapAdd: [], Privileged: false,
    ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges:true'], PidMode: '', IpcMode: '',
  },
  Config: { User: '1001:1001', Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp'] },
  Mounts: [{ Type: 'volume', Name: 'social-mcp-run-check-stage', Destination: '/workspace', RW: false }],
});

test('sandbox command fixes image, network, capabilities, user, rootfs and mount policy', () => {
  const args = buildSandboxContainerArgs({
    name: 'run-check-test', subpath: 'check-abc',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
    command: '/usr/local/bin/python3', args: ['-c', 'print(1)'], timeoutMs: 1000,
  });
  assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'none');
  assert.ok(args.includes('--cap-drop') && args[args.indexOf('--cap-drop') + 1] === 'ALL');
  assert.ok(args.includes('--security-opt') && args[args.indexOf('--security-opt') + 1] === 'no-new-privileges');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--user') && args[args.indexOf('--user') + 1] === '1001:1001');
  assert.ok(args.some(arg => arg.includes('type=volume,source=social-mcp-run-check-stage,target=/workspace,volume-subpath=check-abc,readonly')));
  assert.ok(!args.some(arg => /docker\.sock|--privileged|SYS_ADMIN|apparmor=unconfined|seccomp=unconfined/.test(arg)));
  assert.equal(args.at(-3), 'n150/run-check-sandbox:0.1.0-test');
});

test('container inspection rejects any loss of the required sandbox isolation', () => {
  assert.equal(verifySandboxContainerConfig(safeContainer(), 'check-abc').ok, true);
  const dockerInspectShortName = safeContainer();
  dockerInspectShortName.HostConfig.SecurityOpt = ['no-new-privileges'];
  assert.equal(verifySandboxContainerConfig(dockerInspectShortName, 'check-abc').ok, true);
  for (const mutate of [
    item => { item.HostConfig.NetworkMode = 'host'; },
    item => { item.HostConfig.CapDrop = []; },
    item => { item.HostConfig.CapAdd = ['SYS_ADMIN']; },
    item => { item.HostConfig.Privileged = true; },
    item => { item.HostConfig.ReadonlyRootfs = false; },
    item => { item.Config.User = '0'; },
    item => { item.Mounts[0].RW = true; },
    item => { item.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }); },
    item => { item.Config.Env.push('GITHUB_TOKEN=secret'); },
  ]) {
    const item = safeContainer();
    mutate(item);
    assert.equal(verifySandboxContainerConfig(item, 'check-abc').ok, false);
  }
});

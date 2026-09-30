import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.RUN_CHECK_HARNESS_ROOT = repoRoot;
process.env.RUN_CHECK_SANDBOX_IMAGE = 'n150/run-check-sandbox:0.1.0-test';
const { buildSandboxContainerArgs, verifySandboxContainerConfig, remapRunnerPaths, buildStagedRunCheckSpec } = await import('../infra/github-runner-autoscaler/run-check-executor.mjs');

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
  assert.throws(() => buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: ['src/escape.py'] }, options), /resolves outside the current worktree/);
  assert.throws(() => buildStagedRunCheckSpec(canonicalRoot, stageRoot, { kind: 'python_compile', paths: ['src/missing.py'] }, options), /path does not exist/);
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

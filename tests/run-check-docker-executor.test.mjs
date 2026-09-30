import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.RUN_CHECK_HARNESS_ROOT = repoRoot;
process.env.RUN_CHECK_SANDBOX_IMAGE = 'n150/run-check-sandbox:0.1.0-test';
const { buildSandboxContainerArgs, verifySandboxContainerConfig } = await import('../infra/github-runner-autoscaler/run-check-executor.mjs');

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

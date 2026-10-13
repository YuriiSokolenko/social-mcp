"""Exercise owner deployment orchestration with fake Docker and GitHub, no host changes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.state = self.root / 'state'
        self.scheduler = self.root / 'docker/volumes/social-mcp-runner-scheduler/_data'
        self.scheduler.mkdir(parents=True)
        self.log = self.root / 'commands'
        self.env_file = self.root / '.env'
        self.env_file.write_text('RECURSIVE_CODER_GH_ADMIN_TOKEN=fake-secret\nGH_ADMIN_TOKEN=legacy-secret\n')
        self.env_file.chmod(0o600)
        infra = self.root / 'infra/github-runner-autoscaler'
        infra.mkdir(parents=True)
        self.script = infra / 'deploy-recursive-coder.sh'
        source = (ROOT / 'infra/github-runner-autoscaler/deploy-recursive-coder.sh').read_text()
        self.script.write_text(source.replace('state=/var/lib/recursive-coder-ci-deploy', f'state={self.state}'))
        (infra / 'compose.yaml').write_text('services: {}\n')
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        TEST_ROOT=str(self.root), COMMAND_LOG=str(self.log), REAL_PYTHON=sys.executable)
        self.tool('uname', 'echo x86_64')
        self.tool('id', 'echo 0')
        self.tool('flock', '''count=0
[ ! -f "$TEST_ROOT/flock-count" ] || count="$(cat "$TEST_ROOT/flock-count")"
count=$((count + 1))
printf '%s\n' "$count" > "$TEST_ROOT/flock-count"
if [ "${LOCK_FAIL:-0}" = 1 ] && [ "$count" -ge 2 ]; then exit 1; fi
exit 0''')
        self.tool('git', 'echo test-commit')
        self.tool('df', "printf 'Filesystem 1M-blocks Used Available Use%% Mounted\nroot 50000 10000 40000 20%% /\n'")
        self.tool('awk', '''case "$*" in *MemAvailable*) echo 10000 ;; *) exec /usr/bin/awk "$@" ;; esac''')
        self.tool('python3', r'''case "${3:-}" in
  runners|runs\?*|runners/registration-token)
    [ "${API_FAIL:-0}" = 0 ] || { echo 'GitHub permission preflight failed: HTTP 403'; exit 1; }
    echo "API ${3}" >> "$COMMAND_LOG"
    exit 0 ;;
esac
exec "$REAL_PYTHON" "$@"''')
        self.tool('docker', '''echo "docker $*" >> "$COMMAND_LOG"
case "$1" in
  info|build|tag) exit 0 ;;
  run) [ "${PROBE_FAIL:-0}" = 0 ] ;;
  ps)
    if [ "${BUSY_WORKERS:-0}" = 1 ]; then echo n150-rc-eph-running; fi
    exit 0 ;;
  volume) echo "$TEST_ROOT/docker/volumes/social-mcp-runner-scheduler/_data" ;;
  image) echo sha256:test-image ;;
  stop) exit 0 ;;
  rm) rm -f "$TEST_ROOT/manager-exists" ;;
  inspect)
    case "$*" in
      *Config.Env*)
        case "$2" in
          pi-runner-manager) echo MAX_RUNNERS=8 ;;
          general-runner-manager) echo MAX_RUNNERS=3 ;;
          *) [ "${COORDINATION_MISSING:-0}" = 0 ] && echo SCHEDULER_STATE_DIR=/scheduler || true ;;
        esac ;;
      *recursive-coder-runner-manager*)
        [ -f "$TEST_ROOT/manager-exists" ] || exit 1
        case "$*" in *project*) echo recursive-coder-ci ;; *Running*) echo true ;; esac ;;
      *) printf 'pi-runner-manager pi-id started\ngeneral-runner-manager gen-id started\nn150-control control-id started\n' ;;
    esac ;;
  exec) exit "${COORDINATION_MISSING:-0}" ;;
  compose)
    case "$*" in *' up '*) touch "$TEST_ROOT/manager-exists" ;; esac ;;
  *) exit 1 ;;
esac''')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text('#!/usr/bin/env bash\nset -euo pipefail\n' + body + '\n')
        path.chmod(0o755)

    def run_mode(self, mode, **env):
        (self.root / 'flock-count').unlink(missing_ok=True)
        return subprocess.run(['bash', str(self.script), mode, str(self.env_file)],
                              env=dict(self.env, **env), capture_output=True, text=True)

    def commands(self):
        return self.log.read_text() if self.log.exists() else ''

    def test_dry_run_has_no_mutations_or_secret_output(self):
        result = self.run_mode('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.state.exists())
        for forbidden in ('docker build', 'docker run', ' up ', 'docker stop', 'registration-token', 'fake-secret', 'legacy-secret'):
            self.assertNotIn(forbidden, self.commands() + result.stdout + result.stderr)

    def test_permission_failure_precedes_build(self):
        result = self.run_mode('--deploy', API_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('docker build', self.commands())
        self.assertNotIn(' up ', self.commands())

    def test_sandbox_failure_never_starts_manager(self):
        result = self.run_mode('--deploy', PROBE_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Sandbox blocker', result.stderr)
        self.assertNotIn(' up ', self.commands())
        self.assertNotIn('docker stop', self.commands())

    def test_busy_worker_rollback_preserves_running_manager(self):
        result = self.run_mode('--deploy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.log.write_text('')
        result = self.run_mode('--rollback', BUSY_WORKERS='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Wait for all recursive-coder workers', result.stderr)
        commands = self.commands().splitlines()
        self.assertTrue(any(line.startswith('docker volume inspect ') for line in commands))
        self.assertFalse(any(' docker stop recursive-coder-runner-manager' in line for line in commands))
        self.assertTrue((self.root / 'manager-exists').exists())

    def test_admission_lock_contention_does_not_stop_manager(self):
        result = self.run_mode('--deploy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.log.write_text('')
        result = self.run_mode('--rollback', LOCK_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Runner admission is in progress', result.stderr)
        self.assertFalse(any(' docker stop recursive-coder-runner-manager' in line for line in self.commands().splitlines()))
        self.assertTrue((self.root / 'manager-exists').exists())

    def test_old_manager_without_shared_lock_is_not_stopped(self):
        result = self.run_mode('--deploy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.log.write_text('')
        result = self.run_mode('--rollback', COORDINATION_MISSING='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('lacks shared admission-lock configuration', result.stderr)
        self.assertFalse(any(' docker stop recursive-coder-runner-manager' in line for line in self.commands().splitlines()))
        self.assertTrue((self.root / 'manager-exists').exists())

    def test_targeted_deploy_and_initial_rollback(self):
        result = self.run_mode('--deploy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('up -d --no-deps --no-build recursive-coder-runner-manager', self.commands())
        self.assertNotIn('legacy-secret', (self.state / 'current/env').read_text())
        for forbidden in ('--privileged', 'prune', 'restart', 'docker stop'):
            self.assertNotIn(forbidden, self.commands())
        result = self.run_mode('--rollback', API_FAIL='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('docker stop recursive-coder-runner-manager', self.commands())
        self.assertIn('docker rm recursive-coder-runner-manager', self.commands())
        self.assertFalse((self.root / 'manager-exists').exists())
        result = self.run_mode('--rollback', API_FAIL='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no rollback needed', result.stdout)

    def test_repeat_deployment_keeps_previous_images_and_configuration(self):
        self.assertEqual(self.run_mode('--deploy').returncode, 0)
        self.assertEqual(self.run_mode('--deploy').returncode, 0)
        self.assertTrue((self.state / 'previous/worker-image-id').exists())
        result = self.run_mode('--rollback', API_FAIL='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('docker tag sha256:test-image n150/recursive-coder-runner-manager:0.1.0', self.commands())
        self.assertIn('docker tag sha256:test-image n150/github-recursive-coder-runner-ephemeral:0.1.0', self.commands())

    def test_readable_env_file_is_rejected(self):
        self.env_file.chmod(0o644)
        result = self.run_mode('--dry-run')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('mode 0600', result.stderr)
        self.assertEqual(self.commands(), '')


class WorkerEntrypointTests(unittest.TestCase):
    def test_registration_uses_environment_and_clears_secrets_before_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            probe = root / 'probe'
            probe.write_text('#!/usr/bin/env bash\nexit "${PROBE_STATUS:-0}"\n')
            probe.chmod(0o755)
            entry = root / 'entrypoint'
            entry.write_text((ROOT / 'infra/github-runner-autoscaler/recursive-coder-entrypoint.sh').read_text()
                             .replace('/usr/local/bin/recursive-coder-probe', str(probe)))
            config = root / 'config.sh'
            config.write_text('#!/usr/bin/env bash\nset -eu\n'
                              '[[ "$ACTIONS_RUNNER_INPUT_TOKEN" = temporary-secret ]]\n'
                              '[[ "$*" != *temporary-secret* ]]\n'
                              'touch configured\n')
            config.chmod(0o755)
            run = root / 'run.sh'
            run.write_text('#!/usr/bin/env bash\nset -eu\n'
                           '[[ -z "${RUNNER_TOKEN:-}${GH_ADMIN_TOKEN:-}${ACTIONS_RUNNER_INPUT_TOKEN:-}" ]]\n'
                           'touch executed\n')
            run.chmod(0o755)
            env = dict(os.environ, GITHUB_REPOSITORY='YuriiSokolenko/recursive-coder',
                       RUNNER_NAME='n150-rc-eph-test', RUNNER_LABELS='n150,recursive-coder-ci',
                       RUNNER_TOKEN='temporary-secret', GH_ADMIN_TOKEN='must-not-reach-job')
            failed = subprocess.run(['bash', str(entry)], cwd=root, env=dict(env, PROBE_STATUS='1'),
                                    capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse((root / 'configured').exists())
            passed = subprocess.run(['bash', str(entry)], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(passed.returncode, 0, passed.stderr)
            self.assertTrue((root / 'executed').exists())
            self.assertNotIn('temporary-secret', passed.stdout + passed.stderr)


if __name__ == '__main__':
    unittest.main()

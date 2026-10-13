#!/usr/bin/env bash
# Owner-only deployment. No sudo invocation, daemon restart, prune or legacy rollout.
set -euo pipefail
umask 077
root="$(cd "$(dirname "$0")/../.." && pwd)"
service=recursive-coder-runner-manager
manager_image=n150/recursive-coder-runner-manager:0.1.0
worker_image=n150/github-recursive-coder-runner-ephemeral:0.1.0
state=/var/lib/recursive-coder-ci-deploy
mode="${1:---dry-run}"
env_file="${2:-/home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env}"
fail() { echo "ERROR: $*" >&2; exit 1; }
case "$mode" in --dry-run|--deploy|--rollback) ;; *) fail 'Usage: deploy-recursive-coder.sh [--dry-run|--deploy|--rollback] [absolute .env path]' ;; esac
[[ "$env_file" = /* && -f "$env_file" ]] || fail 'Supply an absolute path to an existing protected .env file'
# Reject group/world readable secrets and symlinks. Never source an env file as code.
python3 - "$env_file" <<'PY'
import os, stat, sys
p = sys.argv[1]
s = os.lstat(p)
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077:
    raise SystemExit('Secret env file must be a regular file with mode 0600 or stricter')
PY
compose=(docker compose --project-name recursive-coder-ci --env-file "$env_file" -f "$root/infra/github-runner-autoscaler/compose.yaml" --profile recursive-coder)
# API output is only the HTTP status; secrets are neither argv nor evidence.
api_check() {
  python3 - "$env_file" "$1" <<'PY'
import json, sys, urllib.request, urllib.error
values = {}
for line in open(sys.argv[1]):
    key, sep, value = line.strip().partition('=')
    if sep:
        values[key] = value.strip().strip('"').strip("'")
token = values.get('RECURSIVE_CODER_GH_ADMIN_TOKEN', '')
if not token or any(c in token for c in '\r\n'):
    raise SystemExit('Set RECURSIVE_CODER_GH_ADMIN_TOKEN: Administration R/W + Actions Read on recursive-coder')
path = sys.argv[2]
req = urllib.request.Request('https://api.github.com/repos/YuriiSokolenko/recursive-coder/actions/' + path,
    headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'},
    method='POST' if path == 'runners/registration-token' else 'GET')
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
except urllib.error.HTTPError as e:
    raise SystemExit('GitHub permission preflight failed: HTTP ' + str(e.code))
except urllib.error.URLError:
    raise SystemExit('GitHub permission preflight failed: network unavailable')
if path == 'runners/registration-token' and not data.get('token'):
    raise SystemExit('Registration token API returned no token')
print('GitHub permission preflight passed: ' + path)
PY
}
legacy_snapshot() {
  docker inspect pi-runner-manager general-runner-manager n150-control \
    --format '{{.Name}} {{.Id}} {{.State.StartedAt}}' | sort
}
require_manager_coordination() {
  local manager_env
  manager_env="$(docker inspect "$service" --format '{{range .Config.Env}}{{println .}}{{end}}')" \
    || fail 'Cannot validate runner admission coordination; manager remains running'
  printf '%s\n' "$manager_env" | grep -Fxq 'SCHEDULER_STATE_DIR=/scheduler' \
    || fail 'Manager lacks shared admission-lock configuration; refusing disruptive rollback'
  docker exec "$service" grep -Fq 'flock -w "$DOCKER_TIMEOUT_SECONDS" 9' \
    /usr/local/bin/pi-runner-manager \
    || fail 'Manager lacks shared admission-lock support; refusing disruptive rollback'
}
no_active_workers() {
  local names
  names="$(docker ps -a --filter label=social-mcp.runner-repository=YuriiSokolenko/recursive-coder --format '{{.Names}}')"
  [ -z "$names" ] || fail 'Wait for all recursive-coder workers to finish; no active job will be stopped'
}
[ "$(uname -m)" = x86_64 ] || fail 'Deploy only on the amd64 N150 host'
docker info >/dev/null || fail 'Docker daemon unavailable'
"${compose[@]}" config --quiet
if [ "$mode" != --rollback ]; then
api_check runners
api_check 'runs?per_page=1'
# Live legacy limits must fit the reservation. Read selected non-secret values only.
legacy_max=0
for name in pi-runner-manager general-runner-manager; do
  limit="$(docker inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MAX_RUNNERS=//p')"
  [[ "$limit" =~ ^[1-9][0-9]*$ ]] || fail "Cannot determine $name MAX_RUNNERS"
  legacy_max=$((legacy_max + limit))
done
python3 - "$env_file" "$legacy_max" <<'PY'
import sys
v = dict(line.strip().split('=', 1) for line in open(sys.argv[1]) if '=' in line and not line.lstrip().startswith('#'))
reserved = int(v.get('LEGACY_RESERVED_RUNNERS', '11'))
cap = int(v.get('HOST_MAX_EPHEMERAL', '12'))
if reserved < int(sys.argv[2]) or cap <= reserved:
    raise SystemExit('Legacy maximum must fit LEGACY_RESERVED_RUNNERS, with one additional slot')
PY
[ "$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)" -ge 7168 ] || fail 'Need 4 GiB worker + 3 GiB host/control headroom'
[ "$(df -Pm "$root" | awk 'NR==2 {print $4}')" -ge 10240 ] || fail 'Need at least 10 GiB free disk'
if [ "$mode" = --dry-run ]; then
  echo 'Read-only preflight passed. No build, start, stop, registration token or host policy change.'
  echo 'Deployment will build only the two explicit recursive-coder images, then require the hardened bwrap probe to pass.'
  echo 'If the probe fails, STOP: document seccomp/AppArmor blocker; do not relax host policy.'
  exit 0
fi
fi
[ "$(id -u)" = 0 ] || fail 'Only the owner may run --deploy/--rollback manually as root'
mkdir -p "$state"
exec 9>"$state/deploy.lock"
flock -n 9 || fail 'Another deployment is running'
before="$(legacy_snapshot)"
manager_exists=false
if docker inspect "$service" >/dev/null 2>&1; then
  manager_exists=true
  project="$(docker inspect "$service" --format '{{index .Config.Labels "com.docker.compose.project"}}')"
  [ "$project" = recursive-coder-ci ] || fail 'Existing manager belongs to another project; refusing adoption'
fi
if [ "$mode" = --rollback ]; then
  if [ "$manager_exists" = false ]; then
    echo 'Recursive-coder manager is absent; no rollback needed.'
    exit 0
  fi
  require_manager_coordination
  scheduler_mount="$(docker volume inspect social-mcp-runner-scheduler --format '{{.Mountpoint}}')" \
    || fail 'Shared scheduler volume is unavailable; manager remains running'
  case "$scheduler_mount" in */volumes/social-mcp-runner-scheduler/_data) ;; *) fail 'Unexpected scheduler volume mount path' ;; esac
  [ -d "$scheduler_mount" ] || fail 'Scheduler volume mount is not available; manager remains running'
  # The manager holds this same lock across capacity check and docker create.
  # Nonblocking failure leaves the manager and any active worker untouched.
  exec 8>"$scheduler_mount/admission.lock"
  flock -n 8 || fail 'Runner admission is in progress; retry rollback without stopping the manager'
  # Check before stopping (preserves manager on busy failure), then again after
  # stop while the shared lock guarantees no manager can start a new worker.
  no_active_workers
  docker stop "$service" >/dev/null
  no_active_workers
  if [ ! -f "$state/previous/compose.yaml" ]; then
    docker rm "$service" >/dev/null
    rm -rf "$state/current"
    [ "$(legacy_snapshot)" = "$before" ] || fail 'Legacy identity/uptime changed'
    echo 'Initial deployment rolled back; only the recursive-coder manager was removed.'
    exit 0
  fi
  # Previous image ID is immutable; no broad teardown or worker stop.
  prior="$(cat "$state/previous/image-id")"
  docker image inspect "$prior" >/dev/null || fail 'Previous manager image is missing'
  docker tag "$prior" "$manager_image"
  docker tag "$(cat "$state/previous/worker-image-id")" "$worker_image"
  docker compose --project-name recursive-coder-ci --env-file "$state/previous/env" \
    -f "$state/previous/compose.yaml" --profile recursive-coder up -d --no-deps --no-build "$service"
  rm -rf "$state/current"
  cp -a "$state/previous" "$state/current"
else
  # Serialize upgrades against this pool's worker admission as well.
  if [ "$manager_exists" = true ]; then
    require_manager_coordination
    scheduler_mount="$(docker volume inspect social-mcp-runner-scheduler --format '{{.Mountpoint}}')" \
      || fail 'Shared scheduler volume is unavailable; manager remains running'
    case "$scheduler_mount" in */volumes/social-mcp-runner-scheduler/_data) ;; *) fail 'Unexpected scheduler volume mount path' ;; esac
    [ -d "$scheduler_mount" ] || fail 'Scheduler volume mount is not available; manager remains running'
    exec 8>"$scheduler_mount/admission.lock"
    flock -n 8 || fail 'Runner admission is in progress; retry deployment without recreating the manager'
  fi
  # Save exactly the last successful configuration before any image tag changes.
  no_active_workers
  if [ -d "$state/current" ]; then
    rm -rf "$state/previous"
    cp -a "$state/current" "$state/previous"
  fi
  api_check runners/registration-token
  docker build --platform linux/amd64 -f "$root/infra/github-runner-autoscaler/worker-recursive-coder.Dockerfile" -t "$worker_image" "$root"
  docker build --platform linux/amd64 -f "$root/infra/github-runner-autoscaler/manager.Dockerfile" -t "$manager_image" "$root"
  # No host mounts, privileged mode, Docker socket or policy exceptions in the probe.
  docker run --rm --pull=never --network bridge --cap-drop ALL --security-opt no-new-privileges:true \
    --cpus 2 --memory 4096m --memory-swap 4096m --pids-limit 512 \
    --entrypoint /usr/local/bin/recursive-coder-probe "$worker_image" \
    || fail 'Sandbox blocker: hardened worker cannot run bwrap; no manager was started'
  "${compose[@]}" up -d --no-deps --no-build "$service"
  [ "$(docker inspect "$service" --format '{{.State.Running}}')" = true ] || fail 'Manager failed to start'
  mkdir -p "$state/current"
  cp "$root/infra/github-runner-autoscaler/compose.yaml" "$state/current/compose.yaml"
  python3 - "$env_file" "$state/current/env" <<'PYENV'
import sys
keys = {'RECURSIVE_CODER_GH_ADMIN_TOKEN', 'HOST_MAX_EPHEMERAL', 'HOST_MEMORY_RESERVE_MB', 'LEGACY_RESERVED_RUNNERS'}
with open(sys.argv[2], 'w') as out:
    for line in open(sys.argv[1]):
        if line.partition('=')[0].strip() in keys:
            out.write(line)
PYENV
  docker image inspect "$manager_image" --format '{{.Id}}' > "$state/current/image-id"
  docker image inspect "$worker_image" --format '{{.Id}}' > "$state/current/worker-image-id"
  git -C "$root" rev-parse HEAD > "$state/current/commit"
fi
[ "$(legacy_snapshot)" = "$before" ] || fail 'Legacy container identity/uptime changed; inspect host immediately'
echo 'Targeted deployment finished; existing managers and control lane retain identity and uptime.'
echo 'Next: verify an actual recursive-coder CI run, all three jobs, runner_name n150-rc-eph-*, and sandbox JUnit results with zero skips.'

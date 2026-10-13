#!/usr/bin/env bash
# Owner-operated, KVM-only deployment. Never restarts or prunes other pools.
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
service=recursive-coder-kvm-runner-manager
container=recursive-coder-kvm-runner-manager
project=recursive-coder-kvm
image=n150/recursive-coder-kvm-runner-manager:0.1.0
state=/var/lib/recursive-coder-kvm-deploy
golden_sha=6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2
mode="${1:---dry-run}"
env_file="${2:-/home/yurasik/github-runners/social-mcp-autoscaler/infra/github-runner-autoscaler/.env}"
fail() { echo "ERROR: $*" >&2; exit 1; }
case "$mode" in --dry-run|--deploy|--verify|--rollback) ;; *) fail 'Usage: deploy-recursive-coder-kvm.sh [--dry-run|--deploy|--verify|--rollback] [absolute protected .env path]' ;; esac

[[ "$env_file" = /* && -f "$env_file" ]] || fail 'Supply an absolute path to an existing protected .env file'
python3 - "$env_file" <<'PY'
import os, stat, sys
s = os.lstat(sys.argv[1])
if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077:
    raise SystemExit('Secret env file must be a regular file with mode 0600 or stricter')
PY

value() {
  python3 - "$env_file" "$1" <<'PY'
import sys
key = sys.argv[2]
for line in open(sys.argv[1]):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    name, value = line.split('=', 1)
    if name == key:
        print(value.strip().strip('"').strip("'"))
        break
PY
}
golden_dir="$(value KVM_GOLDEN_HOST_DIR)"
state_dir="$(value KVM_STATE_HOST_DIR)"
golden_dir="${golden_dir:-/var/lib/recursive-coder-kvm/golden}"
state_dir="${state_dir:-/var/lib/recursive-coder-kvm/state}"
[[ "$golden_dir" == /var/lib/recursive-coder-kvm/golden \
  && "$state_dir" == /var/lib/recursive-coder-kvm/state ]] \
  || fail 'KVM image and state directories must use the dedicated /var/lib/recursive-coder-kvm paths'
golden="$golden_dir/noble-server-cloudimg-amd64.img"
compose=(docker compose --project-name "$project" --env-file "$env_file" \
  -f "$root/infra/github-runner-autoscaler/compose.yaml" --profile recursive-coder-kvm)
disk_probe="$state_dir"
while [ ! -d "$disk_probe" ]; do disk_probe="$(dirname "$disk_probe")"; done

legacy_snapshot() {
  docker inspect pi-runner-manager general-runner-manager n150-control \
    --format '{{.Name}} {{.Id}} {{.State.StartedAt}}' | sort
}
require_lock_support() {
  local configured
  configured="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}')" \
    || fail 'Cannot verify KVM manager coordination; no service was stopped'
  printf '%s\n' "$configured" | grep -Fxq 'SCHEDULER_STATE_DIR=/scheduler' \
    || fail 'KVM manager does not use the shared scheduler lock'
  docker exec "$container" grep -Fq 'flock -w "$DOCKER_TIMEOUT_SECONDS" 9' \
    /usr/local/bin/pi-runner-manager || fail 'KVM manager lacks shared-lock support'
}
manager_running() {
  docker inspect "$container" >/dev/null 2>&1 \
    && [ "$(docker inspect "$container" --format '{{.State.Running}}')" = true ]
}
lock_scheduler() {
  local scheduler_mount
  scheduler_mount="$(docker volume inspect social-mcp-runner-scheduler --format '{{.Mountpoint}}')" \
    || fail 'Shared scheduler volume is unavailable'
  case "$scheduler_mount" in */volumes/social-mcp-runner-scheduler/_data) ;; *) fail 'Unexpected scheduler volume path' ;; esac
  [ -d "$scheduler_mount" ] || fail 'Scheduler volume mount is unavailable'
  exec 8>"$scheduler_mount/admission.lock"
  flock -n 8 || fail 'Runner admission is in progress; retry when the lock is free'
}
no_active_vm() {
  if docker inspect "$container" >/dev/null 2>&1 \
    && [ "$(docker inspect "$container" --format '{{.State.Running}}')" = true ]; then
    local active
    active="$(docker exec "$container" python3 /usr/local/bin/kvm-backend.py list)" \
      || fail 'Cannot inspect KVM workers; manager remains running'
    [ -z "$active" ] || fail 'Wait for the active one-job VM to finish; no job will be interrupted'
  fi
}
api_check() {
  python3 - "$env_file" "$1" <<'PY'
import json, sys, urllib.request, urllib.error
values = {}
for line in open(sys.argv[1]):
    key, sep, value = line.strip().partition('=')
    if sep and not key.startswith('#'):
        values[key] = value.strip().strip('"').strip("'")
token = values.get('RECURSIVE_CODER_GH_ADMIN_TOKEN', '')
if not token or any(c in token for c in '\r\n'):
    raise SystemExit('Set a repository-scoped RECURSIVE_CODER_GH_ADMIN_TOKEN in the protected .env file')
path = sys.argv[2]
request = urllib.request.Request(
    'https://api.github.com/repos/YuriiSokolenko/recursive-coder/actions/' + path,
    headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
             'X-GitHub-Api-Version': '2026-03-10'},
    method='POST' if path.endswith('registration-token') else 'GET')
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
except urllib.error.HTTPError as error:
    raise SystemExit('GitHub permission preflight failed: HTTP ' + str(error.code))
except urllib.error.URLError:
    raise SystemExit('GitHub permission preflight failed: network unavailable')
if path.endswith('registration-token') and not result.get('token'):
    raise SystemExit('Registration-token endpoint returned no token')
print('GitHub API permission preflight passed')
PY
}
verify_service() {
  [ "$(docker inspect "$container" --format '{{.State.Running}}')" = true ] || fail 'KVM manager is not running'
  docker inspect "$container" | python3 -c '
import json, sys
c = json.load(sys.stdin)[0]
assert c["Config"]["Labels"].get("com.docker.compose.project") == "recursive-coder-kvm"
mounts = {m["Destination"]: m["RW"] for m in c["Mounts"]}
assert mounts == {"/golden": False, "/kvm-state": True, "/scheduler": True}
h = c["HostConfig"]
assert not h["Privileged"] and h["Memory"] == 5120 * 1024 * 1024
assert h["NanoCpus"] == 2250000000 and len(h["Devices"]) == 1
assert h["Devices"][0]["PathOnHost"] == "/dev/kvm"
assert not h.get("PortBindings")
assert "no-new-privileges:true" in h["SecurityOpt"]
assert "WORKER_BACKEND=kvm" in c["Config"]["Env"]
assert "GITHUB_REPOSITORY=YuriiSokolenko/recursive-coder" in c["Config"]["Env"]
' || fail 'KVM container mount, device or resource policy verification failed'
  docker exec "$container" python3 /usr/local/bin/kvm-backend.py verify >/dev/null \
    || fail 'KVM backend or pinned golden image verification failed'
  echo 'KVM manager, read-only golden image, state volume and /dev/kvm verified.'
}

[ "$(uname -m)" = x86_64 ] || fail 'KVM deployment requires an x86_64 host'
if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  fail 'Host user lacks read/write access to /dev/kvm'
fi
cpu_count="$(getconf _NPROCESSORS_ONLN)"
[ "$cpu_count" -ge 4 ] || fail 'Need 2 guest vCPUs plus 2 host-reserved CPUs'
[ "$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)" -ge 8192 ] || fail 'Need 5 GiB KVM manager limit plus 3 GiB host reserve'
if [ "$mode" = --dry-run ]; then
  [ ! -e "$golden" ] || [ "$(sha256sum "$golden" | awk '{print $1}')" = "$golden_sha" ] \
    || fail 'Existing golden image has an unexpected SHA-256; refusing replacement'
  [ ! -e "$state_dir" ] || [ "$(stat -c '%a' "$state_dir")" = 700 ] \
    || fail 'KVM state directory must have mode 0700'
  [ "$(df -Pm "$disk_probe" | awk 'NR==2 {print $4}')" -ge 25600 ] \
    || fail 'Need at least 25 GiB free for a bounded 24 GiB overlay'
  docker info >/dev/null || fail 'Docker daemon unavailable'
  "${compose[@]}" config --quiet
  echo 'Read-only KVM preflight passed; no assets or services were changed.'
  exit 0
fi

if [ "$mode" = --verify ]; then
  docker info >/dev/null || fail 'Docker daemon unavailable'
  verify_service
  exit 0
fi

[ "$(id -u)" = 0 ] || fail "Only the owner runs --deploy/--rollback with sudo; no sudo was invoked by this script"
docker info >/dev/null || fail 'Docker daemon unavailable'
before="$(legacy_snapshot)"
mkdir -p "$state"
chmod 0700 "$state"
exec 9>"$state/deploy.lock"
flock -n 9 || fail 'Another KVM deployment operation is running'

if [ "$mode" = --rollback ]; then
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo 'KVM manager is already absent; nothing to roll back.'
    exit 0
  fi
  if manager_running; then
    require_lock_support
    lock_scheduler
  fi
  no_active_vm
  docker stop --time 30 "$container" >/dev/null
  docker rm "$container" >/dev/null
  if [ -d "$state/previous" ]; then
    previous_image="$(cat "$state/previous/image-id")"
    docker image inspect "$previous_image" >/dev/null || fail 'Previous KVM image is unavailable'
    docker tag "$previous_image" "$image"
    docker compose --project-name "$project" --env-file "$state/previous/env" \
      -f "$state/previous/compose.yaml" --profile recursive-coder-kvm \
      up -d --no-deps --no-build "$service"
    verify_service
    python3 - "$state" <<'PY'
from pathlib import Path
import shutil, sys
root = Path(sys.argv[1])
current, previous = root / 'current', root / 'previous'
if current.exists():
    shutil.rmtree(current)
shutil.copytree(previous, current)
PY
    echo 'Previous KVM manager image and configuration restored.'
  else
    echo 'Initial KVM deployment rolled back; only the KVM manager was removed.'
  fi
  [ "$(legacy_snapshot)" = "$before" ] || fail 'Existing Pi, General or Control identity/start time changed'
  exit 0
fi

install -d -o root -g root -m 0755 "$golden_dir"
install -d -o root -g root -m 0700 "$state_dir"

if docker inspect recursive-coder-runner-manager >/dev/null 2>&1 \
  && [ "$(docker inspect recursive-coder-runner-manager --format '{{.State.Running}}')" = true ]; then
  fail 'The Docker recursive-coder manager is running; prevent duplicate job capacity before enabling KVM'
fi
old_workers="$(docker ps -aq --filter label=social-mcp.runner-repository=YuriiSokolenko/recursive-coder)"
[ -z "$old_workers" ] || fail 'Drain existing Docker recursive-coder workers before enabling the KVM pool'

"${compose[@]}" config --quiet
[ -f "$golden" ] || {
  temporary="$golden.part.$$"
  cleanup_download() {
    [ -n "${temporary:-}" ] || return 0
    python3 - "$temporary" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
  }
  trap cleanup_download EXIT
  curl -fL --retry 3 --connect-timeout 10 --max-time 900 \
    https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img -o "$temporary"
  echo "$golden_sha  $temporary" | sha256sum -c - || fail 'Ubuntu golden image checksum mismatch'
  chmod 0444 "$temporary"
  mv "$temporary" "$golden"
  temporary=""
  trap - EXIT
}
[ "$(sha256sum "$golden" | awk '{print $1}')" = "$golden_sha" ] || fail 'Golden image checksum mismatch'
chmod 0444 "$golden"
chmod 0700 "$state_dir"
[ "$(df -Pm "$state_dir" | awk 'NR==2 {print $4}')" -ge 25600 ] || fail 'Need at least 25 GiB free for a bounded 24 GiB overlay'
api_check runners
api_check runners/registration-token
if manager_running; then require_lock_support; fi
lock_scheduler
no_active_vm
had_previous=false
if [ -d "$state/current" ]; then
  had_previous=true
  python3 - "$state" <<'PY'
from pathlib import Path
import shutil, sys
root = Path(sys.argv[1])
previous = root / 'previous'
if previous.exists():
    shutil.rmtree(previous)
shutil.copytree(root / 'current', previous)
PY
fi
if [ "$had_previous" = true ] && docker image inspect "$image" >/dev/null 2>&1; then
  docker image inspect "$image" --format '{{.Id}}' >"$state/previous-image-candidate"
fi
"${compose[@]}" build "$service"
"${compose[@]}" up -d --no-deps "$service"
verify_service
mkdir -p "$state/current"
cp "$root/infra/github-runner-autoscaler/compose.yaml" "$state/current/compose.yaml"
cp "$env_file" "$state/current/env"
chmod 0600 "$state/current/env"
if [ -f "$state/previous-image-candidate" ]; then
  if [ "$had_previous" = true ]; then
    mv "$state/previous-image-candidate" "$state/previous/image-id"
  else
    python3 - "$state/previous-image-candidate" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
  fi
fi
[ "$(legacy_snapshot)" = "$before" ] || fail 'Existing Pi, General or Control identity/start time changed'
echo 'KVM manager deployed and verified. No existing runner pool was restarted.'

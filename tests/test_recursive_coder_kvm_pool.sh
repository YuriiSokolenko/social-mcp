#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -m 700 "$tmp/state" "$tmp/scheduler"
cat >"$tmp/backend.py" <<'PY'
import os
import sys
from pathlib import Path

command = sys.argv[1]
if command == "list":
    active = Path(os.environ["TEST_ACTIVE_NAMES"])
    if active.exists():
        print(active.read_text(), end="")
elif command == "start":
    name = sys.argv[sys.argv.index("--name") + 1]
    Path(os.environ["TEST_START_NAME"]).write_text(name)
    Path(os.environ["TEST_START_TOKEN"]).write_text(sys.stdin.read())
elif command == "stop":
    Path(os.environ["TEST_STOP_NAME"]).write_text(sys.argv[sys.argv.index("--name") + 1])
else:
    raise SystemExit(2)
PY

export GH_ADMIN_TOKEN=not-used-by-fixture
export GITHUB_REPOSITORY=YuriiSokolenko/recursive-coder
export WORKER_BACKEND=kvm MAX_RUNNERS=1 RUNNER_PREFIX=n150-rc-eph
export RUNNER_LABELS=n150,recursive-coder-ci WORKFLOW_FILES=ci.yml
export MOUNT_PI_CONFIG=false MOUNT_DOCKER_SOCKET=false RUN_CHECK_EXECUTOR_ENABLED=false
export SCHEDULER_STATE_DIR="$tmp/scheduler" KVM_STATE_DIR="$tmp/state"
export KVM_BACKEND_SCRIPT="$tmp/backend.py" KVM_START_TIMEOUT_SECONDS=5
export KVM_GUEST_CPUS=2 KVM_MIN_HOST_CPU_HEADROOM=1 KVM_OVERLAY_MAX_GIB=1 KVM_IDLE_POLLS_BEFORE_STOP=4
export HOST_MAX_EPHEMERAL=2 LEGACY_RESERVED_RUNNERS=1 HOST_MEMORY_RESERVE_MB=1 WORKER_MEMORY_MB=1
export TEST_ACTIVE_NAMES="$tmp/active" TEST_START_NAME="$tmp/start-name" TEST_START_TOKEN="$tmp/start-token"
export TEST_STOP_NAME="$tmp/stop-name"
source "$ROOT/infra/github-runner-autoscaler/manager.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
registration_token() { printf '%s\n' 'mock-short-lived-registration-token'; }
getconf() { printf '4\n'; }
host_cpu_load_1m() { printf '%s\n' "${TEST_HOST_CPU_LOAD_1M:-0}"; }
host_mem_available_mb() { printf '%s\n' "${TEST_HOST_MEM_AVAILABLE_MB:-2}"; }

active_containers() { echo 0; }
resource_admission || fail 'KVM resource admission rejected bounded capacity'
TEST_HOST_MEM_AVAILABLE_MB=1
if resource_admission; then fail 'KVM backend admitted a runner below the host memory reserve'; fi
TEST_HOST_MEM_AVAILABLE_MB=unknown
if resource_admission; then fail 'KVM backend admitted a runner with invalid host memory data'; fi
TEST_HOST_MEM_AVAILABLE_MB=2
TEST_HOST_CPU_LOAD_1M=1.1
if resource_admission; then fail 'KVM backend ignored measured host load headroom'; fi
TEST_HOST_CPU_LOAD_1M=0
active_containers() { echo 1; }
if resource_admission; then fail 'KVM backend exceeded the one-VM cap'; fi
active_containers() { echo 0; }
LEGACY_RESERVED_RUNNERS=2
if resource_admission; then fail 'KVM backend ignored legacy runner reservations'; fi
LEGACY_RESERVED_RUNNERS=1

spawn_runner_unlocked || fail 'KVM backend failed to start the fake VM'
[ "$(cat "$tmp/start-token")" = mock-short-lived-registration-token ] || fail 'registration token was not delivered over stdin'
[[ "$(cat "$tmp/start-name")" == n150-rc-eph-* ]] || fail 'runner name did not use its pool prefix'

echo n150-rc-eph-active >"$tmp/active"
[[ "$(pool_containers)" == n150-rc-eph-active ]] || fail 'active KVM VM was not counted'
python3 "$KVM_BACKEND_SCRIPT" stop --name n150-rc-eph-active
[ "$(cat "$tmp/stop-name")" = n150-rc-eph-active ] || fail 'idle VM cleanup did not call the KVM backend'

echo 'recursive-coder KVM manager checks passed'

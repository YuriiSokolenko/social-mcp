#!/usr/bin/env bash
# Functions/variables below deliberately override functions from the sourced manager.
# shellcheck disable=SC1091,SC2034,SC2329
set -euo pipefail
export GH_ADMIN_TOKEN=test-token GITHUB_REPOSITORY=YuriiSokolenko/recursive-coder
source "$(dirname "$0")/../infra/github-runner-autoscaler/manager.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
assert_failure() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }
WORKFLOW_FILES=ci.yml RUNNER_LABELS=n150,recursive-coder-ci RUNNER_PREFIX=n150-rc-eph
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
api_get() {
  case "$1" in
    *'status=queued'*) printf '%s' '{"total_count":1,"workflow_runs":[{"id":7,"path":".github/workflows/ci.yml","event":"push"}]}' ;;
    *'status=pending'*) printf '%s' '{"total_count":1,"workflow_runs":[{"id":8,"path":".github/workflows/ci.yml","event":"pull_request","head_repository":{"full_name":"fork/recursive-coder"}}]}' ;;
    *'status=in_progress'*) printf '%s' '{"total_count":1,"workflow_runs":[{"id":7,"path":".github/workflows/ci.yml","event":"push"}]}' ;;
    *'/7/jobs?'*) cat "$fixture/jobs.json" ;;
    *) fail "wrong repo, fork or unexpected API URL: $1" ;;
  esac
}
cat > "$fixture/jobs.json" <<'JSON'
{"total_count":8,"jobs":[
 {"status":"queued","labels":["self-hosted","linux","x64","n150","recursive-coder-ci"]},
 {"status":"queued","labels":["SELF-HOSTED","Linux","X64","N150","recursive-coder-ci"]},
 {"status":"queued","labels":["self-hosted","linux","x64","n150","recursive-coder-ci"]},
 {"status":"queued","labels":["self-hosted","n150","general"]},
 {"status":"queued","labels":["self-hosted","n150","pi-agent"]},
 {"status":"queued","labels":["self-hosted","n150","control"]},
 {"status":"queued","labels":["self-hosted","n150","recursive-coder-ci","gpu"]},
 {"status":"in_progress","labels":["self-hosted","n150","recursive-coder-ci"]}
]}
JSON
[[ "$(queued_jobs)" = 3 ]] || fail 'three eligible jobs, fork blocked, overlapping status snapshots deduplicated'
# In-progress workflow alone still exposes the other waiting jobs.
(
  original_api="$(declare -f api_get | sed '1s/api_get/original_api/')"; eval "$original_api"
  api_get() {
    case "$1" in *'status=queued'*) echo '{"total_count":0,"workflow_runs":[]}' ;; *) original_api "$1" ;; esac
  }
  [[ "$(queued_jobs)" = 3 ]] || fail 'waiting jobs in running workflow lost'
)
# Paginate all jobs; never interpret a truncated/error page as zero demand.
(
  api_get() {
    case "$1" in
      *'page=1') jq -nc '{total_count:101,jobs:[range(100)|{id:.,status:"queued",labels:["self-hosted","n150","recursive-coder-ci"]}]}' ;;
      *'page=2') echo '{"total_count":101,"jobs":[{"id":100,"status":"queued","labels":["self-hosted","n150","recursive-coder-ci"]}]}' ;;
      *) fail 'unexpected pagination' ;;
    esac
  }
  [[ "$(api_list "${API}/actions/runs/7/jobs?per_page=100" jobs | jq '.jobs|length')" = 101 ]] || fail 'second jobs page omitted'
  api_get() { echo '{"total_count":101,"jobs":[]}'; }
  assert_failure api_list "${API}/actions/runs/7/jobs?per_page=100" jobs
  api_get() { return 22; }
  assert_failure queued_jobs
)
# Complete runners pagination is also used for busy counts and stale recovery.
(
  api_get() {
    case "$1" in
      *'page=1') jq -nc '{total_count:101,runners:[range(100)|{id:.,name:"another-pool",busy:true}]}' ;;
      *'page=2') echo '{"total_count":101,"runners":[{"id":101,"name":"n150-rc-eph-busy","busy":true}]}' ;;
    esac
  }
  [[ "$(busy_ephemeral_runners)" = 1 ]] || fail 'busy runner on page two lost'
)
# Restart recovery deletes only this repository/prefix's offline registration
# without a matching container. Live-starting and other pools are preserved.
(
  api_get() { echo '{"total_count":3,"runners":[{"id":1,"name":"n150-rc-eph-stale","status":"offline"},{"id":2,"name":"n150-rc-eph-starting","status":"offline"},{"id":3,"name":"n150-gen-eph-stale","status":"offline"}]}'; }
  pool_containers() { echo n150-rc-eph-starting; }
  curl() { printf '%s\n' "${*: -1}" >> "$fixture/deleted"; }
  cleanup_stale_registrations
  [[ "$(cat "$fixture/deleted")" = "${API}/actions/runners/1" ]] || fail 'restart recovery crossed pool/repo boundary'
)
# New workers have exact Docker repo/pool filters as well as prefix checks.
(
  WORKER_HARDENED=true
  run_with_timeout() { printf '%s\n' "$*" > "$fixture/filters"; echo n150-rc-eph-1; }
  [[ "$(active_containers)" = 1 ]] || fail 'new pool count'
  grep -q 'label=social-mcp.runner-repository=YuriiSokolenko/recursive-coder' "$fixture/filters" || fail 'repo Docker filter absent'
  grep -q 'label=social-mcp.runner-pool=n150-rc-eph' "$fixture/filters" || fail 'pool Docker filter absent'
)
# Hardened spawn contains no host socket, host networking, Pi or admin token.
(
  MOUNT_PI_CONFIG=false MOUNT_DOCKER_SOCKET=false WORKER_HARDENED=true WORKER_NETWORK=bridge
  general_daemon_health() { :; }
  registration_token() { echo temporary-registration-secret; }
  run_with_timeout() { printf '%s\n' "$*" > "$fixture/spawn"; [[ "$RUNNER_TOKEN" = temporary-registration-secret ]] || fail 'token not passed via environment'; }
  spawn_runner
  grep -q -- '--network bridge' "$fixture/spawn" || fail 'bridge absent'
  grep -q -- '--cap-drop ALL --security-opt no-new-privileges:true --cpus 2 --memory 4096m' "$fixture/spawn" || fail 'worker limits absent'
  ! grep -Eq 'temporary-registration-secret|GH_ADMIN_TOKEN|--privileged|docker.sock|pi-config|--network host' "$fixture/spawn" || fail 'worker privilege or argv secret leak'
)
# Non-model pools use their own cap, independent of Pi/model capacity.
(
  MOUNT_PI_CONFIG=false MAX_RUNNERS=1 MODEL_MAX_CONCURRENCY=0 MODEL_STATUS_URL=''
  [[ "$(model_start_capacity 0)" = '1 unknown 1' ]] || fail 'new pool incorrectly model-gated'
  [[ "$(model_start_capacity 1)" = '1 unknown 0' ]] || fail 'new pool cap exceeded'
)
# Shared admission serializes independent processes, including failed starts.
(
  SCHEDULER_STATE_DIR="$fixture/scheduler"
  mkdir -p "$SCHEDULER_STATE_DIR"
  resource_admission() { [ ! -f "$fixture/reserved" ]; }
  spawn_runner_unlocked() { sleep 0.1; touch "$fixture/reserved"; echo started >> "$fixture/starts"; }
  spawn_runner & a=$!
  spawn_runner & b=$!
  wait "$a" || true; wait "$b" || true
  [[ "$(wc -l < "$fixture/starts" | tr -d ' ')" = 1 ]] || fail 'concurrent managers over-admitted'
  rm "$fixture/reserved"
  spawn_runner_unlocked() { return 1; }
  assert_failure spawn_runner
  spawn_runner_unlocked() { :; }
  spawn_runner || fail 'failed spawn leaked admission lock'
)
# Full global pool and legacy reservation both fail closed without eviction.
(
  run_with_timeout() { for _ in {1..12}; do echo legacy-worker; done; }
  assert_failure resource_admission
  run_with_timeout() { :; }
  LEGACY_RESERVED_RUNNERS=12
  active_containers() { echo 0; }
  assert_failure resource_admission
  LEGACY_RESERVED_RUNNERS=11
  active_containers() { echo 1; }
  assert_failure resource_admission
  HOST_MEMORY_RESERVE_MB=999999
  active_containers() { echo 0; }
  assert_failure resource_admission
  HOST_MEMORY_RESERVE_MB=1 WORKER_MEMORY_MB=1
  resource_admission || fail 'available host headroom did not permit bounded admission'
  run_with_timeout() { return 1; }
  assert_failure resource_admission
)
echo 'recursive-coder pool checks passed'

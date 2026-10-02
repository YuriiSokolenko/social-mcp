#!/usr/bin/env bash
set -euo pipefail

export GH_ADMIN_TOKEN=test-token GITHUB_REPOSITORY=example/repo
source "$(dirname "$0")/../infra/github-runner-autoscaler/manager.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_failure() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }

# run_with_timeout must never block the caller past its own deadline, and must
# never block past the wrapped command's actual completion when it finishes
# early -- a prior version left a killed watchdog holding the caller's stdout
# pipe open, so $(...) silently blocked for the full deadline even when the
# wrapped command had already returned.
start="$(date +%s)"
out="$(run_with_timeout 30 echo fast)"
elapsed=$(( $(date +%s) - start ))
[[ "$out" == fast ]] || fail 'run_with_timeout must return the wrapped command output'
[[ "$elapsed" -le 2 ]] || fail "run_with_timeout blocked ${elapsed}s past a fast command's own completion"

start="$(date +%s)"
if out="$(run_with_timeout 1 sleep 30)"; then
  fail 'run_with_timeout must fail when the command exceeds its deadline'
fi
elapsed=$(( $(date +%s) - start ))
[[ "$elapsed" -le 3 ]] || fail "run_with_timeout did not enforce its deadline, took ${elapsed}s for a 1s budget"

run_with_timeout 5 true || fail 'run_with_timeout must succeed for a command well under budget'

api_get() {
  case "$1" in
    *'/actions/runs?status=queued'*)
      if [[ "${QUEUED_FAIL:-0}" == 1 ]]; then return 22; fi
      if [[ "${QUEUED_RESPONSE+x}" ]]; then printf '%s' "$QUEUED_RESPONSE"; else printf '%s' '{"total_count":0,"workflow_runs":[]}'; fi ;;
    *'/actions/runs?status=pending'*)
      if [[ "${PENDING_FAIL:-0}" == 1 ]]; then return 22; fi
      if [[ "${PENDING_RESPONSE+x}" ]]; then printf '%s' "$PENDING_RESPONSE"; else printf '%s' '{"total_count":0,"workflow_runs":[]}'; fi ;;
    */actions/runners?*) if [[ "${RUNNERS_RESPONSE+x}" ]]; then printf '%s' "$RUNNERS_RESPONSE"; else printf '%s' '{"runners":[]}'; fi ;;
    *) fail "unexpected API request: $1" ;;
  esac
}

docker() {
  [[ "$1" == ps ]] || fail "unexpected Docker command"
  if [[ "${DOCKER_FAIL:-0}" == 1 ]]; then return 1; fi
  printf '%s\n' "${CONTAINER_NAMES:-}"
}

curl() {
  if [[ "${*: -1}" == "${MODEL_STATUS_URL:-unused}" ]]; then
    if [[ "${STATUS_FAIL:-0}" == 1 ]]; then return 22; fi
    printf '%s' "${STATUS_RESPONSE:-}"
  elif [[ "$*" == *' -X DELETE '* ]]; then
    printf '%s\n' "${*: -1}" >> "$DELETED_IDS"
  else
    fail "unexpected curl command"
  fi
}

WORKFLOW_FILES=first.yml,second.yml
QUEUED_RESPONSE='{"total_count":2,"workflow_runs":[{"path":".github/workflows/first.yml"},{"path":".github/workflows/second.yml"}]}'
PENDING_RESPONSE='{"total_count":2,"workflow_runs":[{"path":".github/workflows/first.yml"},{"path":".github/workflows/third.yml"}]}'
[[ "$(queued_jobs)" == 3 ]] || fail 'queued and pending run counts, filtered to watched workflow files'

PENDING_FAIL=1
assert_failure queued_jobs
unset PENDING_FAIL

for invalid in 'null' '"abc"' '-1' '1.5' '"3"'; do
  PENDING_RESPONSE="{\"total_count\":$invalid,\"workflow_runs\":[]}"
  assert_failure queued_jobs
done
PENDING_RESPONSE=''
unset PENDING_RESPONSE

# total_count greater than the returned page means a truncated result --
# must fail rather than silently under-count.
QUEUED_RESPONSE='{"total_count":5,"workflow_runs":[{"path":".github/workflows/first.yml"}]}'
assert_failure queued_jobs
QUEUED_RESPONSE=''
unset QUEUED_RESPONSE

QUEUED_RESPONSE='{"total_count":0}'
assert_failure queued_jobs
unset QUEUED_RESPONSE

CONTAINER_NAMES=$'n150-pi-eph-10\nother-manager-11'
[[ "$(active_containers)" == 1 ]] || fail 'container counting must use runner prefix'

DELETED_IDS="$(mktemp)"
trap 'rm -f "$DELETED_IDS"' EXIT
RUNNERS_RESPONSE='{"runners":[{"id":10,"name":"n150-pi-eph-10","status":"offline"},{"id":11,"name":"other-manager-11","status":"offline"},{"id":12,"name":"n150-pi-eph-12","status":"offline"}]}'
cleanup_stale_registrations
[[ "$(cat "$DELETED_IDS")" == "${API}/actions/runners/12" ]] || fail 'cleanup removed a live or unrelated registration'

RUNNERS_RESPONSE='{"runners":null}'
assert_failure cleanup_stale_registrations
[[ "$(grep -c '' "$DELETED_IDS")" == 1 ]] || fail 'invalid runner list caused deletion'

RUNNERS_RESPONSE='{"runners":[{"id":13,"name":"n150-pi-eph-13","status":"offline"}]}'
DOCKER_FAIL=1
assert_failure cleanup_stale_registrations
assert_failure active_containers
[[ "$(grep -c '' "$DELETED_IDS")" == 1 ]] || fail 'Docker failure caused deletion'
unset DOCKER_FAIL

MODEL_STATUS_URL='http://model:3009/slots'
STATUS_RESPONSE='[{"id":0,"is_processing":true},{"id":1,"is_processing":true},{"id":2,"is_processing":false},{"id":3,"is_processing":false}]'
[[ "$(model_start_capacity 2)" == $'4\t2\t2' ]] || fail 'two Pi jobs leave two slots available'
[[ "$(model_start_capacity 3)" == $'4\t2\t1' ]] || fail 'reserve a slot for Pi between requests'
[[ "$(model_start_capacity 0)" == $'4\t2\t2' ]] || fail 'account for requests from other clients'
STATUS_RESPONSE='[{"id":0,"is_processing":true},{"id":1,"is_processing":true},{"id":2,"is_processing":true},{"id":3,"is_processing":true}]'
[[ "$(model_start_capacity 2)" == $'4\t4\t0' ]] || fail 'a full model must defer more runners'
STATUS_RESPONSE='[]'
assert_failure model_start_capacity 0
STATUS_RESPONSE='[{"id":0}]'
assert_failure model_start_capacity 0
STATUS_FAIL=1
assert_failure model_start_capacity 0
unset STATUS_FAIL

# Qwen's configured global capacity is independent of runner capacity. Verify
# the eight-slot boundary and that finishing one active job opens exactly one
# admission place for the waiting queue.
MODEL_MAX_CONCURRENCY=8
STATUS_RESPONSE='[{"id":0,"is_processing":false},{"id":1,"is_processing":false},{"id":2,"is_processing":false},{"id":3,"is_processing":false},{"id":4,"is_processing":false},{"id":5,"is_processing":false},{"id":6,"is_processing":false},{"id":7,"is_processing":false}]'
[[ "$(model_start_capacity 0)" == $'8\t0\t8' ]] || fail 'zero active jobs admit up to eight Qwen jobs'
STATUS_RESPONSE='[{"id":0,"is_processing":true},{"id":1,"is_processing":true},{"id":2,"is_processing":true},{"id":3,"is_processing":true},{"id":4,"is_processing":true},{"id":5,"is_processing":true},{"id":6,"is_processing":true},{"id":7,"is_processing":false}]'
[[ "$(model_start_capacity 7)" == $'8\t7\t1' ]] || fail 'seven active model jobs leave one Qwen slot'
[[ "$(model_start_capacity 8)" == $'8\t7\t0' ]] || fail 'eight active model jobs block a ninth job'
[[ "$(model_start_capacity 7)" == $'8\t7\t1' ]] || fail 'completing one job frees one Qwen slot'
STATUS_RESPONSE='[{"id":0,"is_processing":true},{"id":1,"is_processing":true},{"id":2,"is_processing":true},{"id":3,"is_processing":true},{"id":4,"is_processing":true},{"id":5,"is_processing":true},{"id":6,"is_processing":true},{"id":7,"is_processing":true},{"id":8,"is_processing":true}]'
[[ "$(model_start_capacity 0)" == $'8\t8\t0' ]] || fail 'runtime slots and busy count are capped by configured model capacity'
MODEL_MAX_CONCURRENCY=invalid
assert_failure model_start_capacity 0
MODEL_MAX_CONCURRENCY=8

STOPPED_NAMES="$(mktemp)"
STATUS_LOG="$(mktemp)"
trap 'rm -f "$DELETED_IDS" "$STOPPED_NAMES" "$STATUS_LOG"' EXIT
STATUS_RESPONSE='[{"id":0,"is_processing":true},{"id":1,"is_processing":false},{"id":2,"is_processing":true},{"id":3,"is_processing":true}]'
(
  queued_jobs() { printf '0\n'; }
  busy_ephemeral_runners() { printf '3\n'; }
  active_containers() { printf '4\n'; }
  cleanup_stale_registrations() { :; }
  api_get() {
    printf '%s' '{"runners":[{"name":"n150-pi-eph-busy","status":"online","busy":true},{"name":"n150-pi-eph-idle","status":"online","busy":false},{"name":"other-manager","status":"online","busy":false}]}'
  }
  # Stub run_with_timeout itself (its own mechanics are covered by the
  # dedicated tests above) rather than docker -- letting the real
  # run_with_timeout background a stub docker function inside this already-
  # nested test subshell has triggered spurious early exits in this harness
  # before; this sidesteps that entirely.
  run_with_timeout() {
    shift
    case "$1" in
      docker)
        case "$2" in
          ps) printf '%s\n' 'n150-pi-eph-busy' 'n150-pi-eph-idle' ;;
          stop) printf '%s\n' "$3" >> "$STOPPED_NAMES" ;;
          *) fail "unexpected docker subcommand: $2" ;;
        esac
        ;;
      *) fail "unexpected run_with_timeout target: $1" ;;
    esac
  }
  # retire_idle_runners now debounces across two consecutive polls (a runner
  # can look idle for one snapshot right as GitHub assigns it a job); run
  # main through two iterations and confirm nothing was stopped after the
  # first one, only after the second.
  polls=0
  sleep() {
    polls=$((polls + 1))
    if [[ "$polls" -eq 1 ]] && [[ -s "$STOPPED_NAMES" ]]; then
      fail 'idle runner stopped on the first poll, before the debounce confirms it'
    fi
    if [[ "$polls" -ge 2 ]]; then
      exit 0
    fi
    return 0
  }
  main > "$STATUS_LOG"
)
[[ "$(cat "$STOPPED_NAMES")" == 'n150-pi-eph-idle' ]] || fail 'idle runner must be stopped once confirmed idle on two consecutive polls'
grep -q 'model_slots_total=4 model_slots_busy=3 model_capacity=0' "$STATUS_LOG" || fail 'log must report total and busy slots even without queued jobs'

STATUS_RESPONSE='[{"id":0,"is_processing":true},{"id":1,"is_processing":true},{"id":2,"is_processing":true},{"id":3,"is_processing":true}]'
(
  queued_jobs() { printf '1\n'; }
  busy_ephemeral_runners() { printf '0\n'; }
  active_containers() { printf '0\n'; }
  cleanup_stale_registrations() { :; }
  spawn_runner() { fail 'spawned a runner despite no free model slots'; }
  sleep() { exit 0; }
  main >/dev/null
)

STATUS_RESPONSE='[{"id":0,"is_processing":false},{"id":1,"is_processing":false},{"id":2,"is_processing":false},{"id":3,"is_processing":false},{"id":4,"is_processing":false},{"id":5,"is_processing":false},{"id":6,"is_processing":false},{"id":7,"is_processing":false}]'
(
  queued_jobs() { printf '8\n'; }
  busy_ephemeral_runners() { printf '0\n'; }
  active_containers() { printf '0\n'; }
  cleanup_stale_registrations() { :; }
  MAX_RUNNERS=8
  spawned=0
  spawn_runner() { spawned=$((spawned + 1)); }
  sleep() { [[ "$spawned" == 8 ]] || fail "expected eight runners, got $spawned"; exit 0; }
  main >/dev/null
)

STATUS_RESPONSE='[{"id":0,"is_processing":false},{"id":1,"is_processing":false},{"id":2,"is_processing":false},{"id":3,"is_processing":false}]'
(
  queued_jobs() { printf '4\n'; }
  busy_ephemeral_runners() { printf '0\n'; }
  active_containers() { printf '0\n'; }
  cleanup_stale_registrations() { :; }
  MAX_RUNNERS=4
  spawned=0
  spawn_runner() { spawned=$((spawned + 1)); }
  sleep() { [[ "$spawned" == 4 ]] || fail "expected four runners, got $spawned"; exit 0; }
  main >/dev/null
)

STATUS_RESPONSE='[{"id":0,"is_processing":true},{"id":1,"is_processing":true},{"id":2,"is_processing":false},{"id":3,"is_processing":false}]'
(
  queued_jobs() { printf '4\n'; }
  busy_ephemeral_runners() { printf '0\n'; }
  active_containers() { printf '0\n'; }
  cleanup_stale_registrations() { :; }
  MAX_RUNNERS=4
  spawned=0
  spawn_runner() { spawned=$((spawned + 1)); }
  sleep() { [[ "$spawned" == 2 ]] || fail "expected two free slots, got $spawned"; exit 0; }
  main >/dev/null
)

MODEL_STATUS_URL='http://model:3009/metrics'
STATUS_RESPONSE=$'vllm:num_requests_running{model_name="test"} 4\nvllm:num_requests_waiting{model_name="test"} 0\n'
[[ "$(model_start_capacity 0)" == '8 4 4' ]] || fail 'vLLM reports running requests and admits remaining model capacity'
STATUS_RESPONSE=$'vllm:num_requests_waiting{model_name="a"} 0\nvllm:num_requests_waiting{model_name="b"} 2\n'
[[ "$(model_start_capacity 0)" == '8 0 0' ]] || fail 'vLLM backlog defers runners'
STATUS_RESPONSE='vllm:num_requests_running 0'
assert_failure model_start_capacity 0

QUEUED_FAIL=1
(
  spawn_runner() { fail 'spawned a runner after API failure'; }
  sleep() { exit 0; }
  main >/dev/null
)
unset QUEUED_FAIL

DOCKER_RUN_LOG="$(mktemp)"
trap 'rm -f "$DELETED_IDS" "$STOPPED_NAMES" "$STATUS_LOG" "$DOCKER_RUN_LOG"' EXIT

# spawn_runner's own run_with_timeout/background-job mechanics are covered
# above; stub run_with_timeout here so this only exercises spawn_runner's
# docker-arg construction (labels, PI-config mount, docker-socket mount).
(
  RUNNER_PREFIX=n150-gen-eph
  RUNNER_IMAGE=test-general-image:tag
  RUNNER_LABELS=n150,general
  PI_ZOEKT_URL=http://127.0.0.1:6070
  PI_ZOEKT_REPOSITORY=YuriiSokolenko/social-mcp
  PI_ZOEKT_TIMEOUT_MS=3000
  MOUNT_PI_CONFIG=false
  MOUNT_DOCKER_SOCKET=true
  registration_token() { printf 'tok\n'; }
  run_with_timeout() {
    shift
    printf '%s\n' "$*" >> "$DOCKER_RUN_LOG"
  }
  spawn_runner
)
grep -q -- '--network host' "$DOCKER_RUN_LOG" || fail 'ephemeral runners must use host networking for local model/Zoekt endpoints'
! grep -q -- '--security-opt seccomp=unconfined' "$DOCKER_RUN_LOG" || fail 'general runners must keep Docker default seccomp'
grep -q -- '-e RUNNER_LABELS=n150,general' "$DOCKER_RUN_LOG" || fail 'spawn_runner must pass RUNNER_LABELS through'
grep -q -- '/var/run/docker.sock:/var/run/docker.sock' "$DOCKER_RUN_LOG" || fail 'spawn_runner must mount the docker socket when MOUNT_DOCKER_SOCKET=true'
grep -q -- '/pi-config-ro:ro' "$DOCKER_RUN_LOG" && fail 'spawn_runner must not mount the Pi config when MOUNT_PI_CONFIG=false'
grep -q -- 'PI_ZOEKT_' "$DOCKER_RUN_LOG" && fail 'general runners must not receive the optional Pi-only Zoekt configuration'
grep -q -- 'run-check-sandbox' "$DOCKER_RUN_LOG" && fail 'general runners run no Pi focused checks, so they do not probe the Pi sandbox image'

# Pi runners use the manager-side disposable Docker backend without receiving the Docker socket or
# any namespace/security relaxation. The manager gate verifies a real sandbox image probe.
: > "$DOCKER_RUN_LOG"
(
  RUNNER_PREFIX=n150-pi-eph
  RUNNER_IMAGE=test-pi-image:tag
  RUN_CHECK_SANDBOX_IMAGE=test-sandbox:0.1.0
  RUN_CHECK_EXECUTOR_URL=http://127.0.0.1:17343
  RUNNER_LABELS=n150,pi-agent
  PI_CONFIG_DIR=/some/pi/config
  MOUNT_PI_CONFIG=true
  MOUNT_DOCKER_SOCKET=false
  RUN_CHECK_EXECUTOR_ENABLED=true
  PI_ZOEKT_URL=http://127.0.0.1:6070
  PI_ZOEKT_REPOSITORY=YuriiSokolenko/social-mcp
  PI_ZOEKT_TIMEOUT_MS=3000
  RUN_CHECK_SANDBOX_VERIFIED=false
  registration_token() { printf 'tok\n'; }
  docker() {
    printf '%s\n' "$*" >> "$DOCKER_RUN_LOG"
    if [[ "$*" == "image inspect test-sandbox:0.1.0 --format {{.Id}}" ]]; then printf 'sha256:test-image-id\n'; return 0; fi
    if [[ "$*" == run* ]]; then printf '{"ok":true}\n'; return 0; fi
    fail "unexpected docker command in manager gate: $*"
  }
  curl() { [[ "$*" == *'/healthz'* ]]; }
  run_with_timeout() { shift; "$@"; }
  spawn_runner
)
grep -q -- '--network host' "$DOCKER_RUN_LOG" || fail 'Pi runners retain their existing host networking'
grep -q -- '/some/pi/config:/pi-config-ro:ro' "$DOCKER_RUN_LOG" || fail 'spawn_runner must mount the Pi config when MOUNT_PI_CONFIG=true'
! grep -q -- '--security-opt seccomp=unconfined' "$DOCKER_RUN_LOG" || fail 'Pi runners must use the default seccomp profile'
! grep -q -- '--cap-add SYS_ADMIN\|--privileged\|apparmor=unconfined' "$DOCKER_RUN_LOG" || fail 'Pi runner launch must not widen privileges'
grep -q -- '/var/run/docker.sock:/var/run/docker.sock' "$DOCKER_RUN_LOG" && fail 'Pi runner must not receive the Docker socket'
grep -q -- '-e PI_RUN_CHECK_EXECUTOR_URL=http://127.0.0.1:17343' "$DOCKER_RUN_LOG" || fail 'Pi runner must receive only the trusted executor endpoint'
grep -q -- '-e RUN_CHECK_EXECUTOR_TOKEN=' "$DOCKER_RUN_LOG" || fail 'Pi runner must receive an ephemeral executor request token'
grep -q -- 'run --rm --pull=never --network none --cap-drop ALL --security-opt no-new-privileges' "$DOCKER_RUN_LOG" || fail 'manager gate must execute a hardened real sandbox image probe'
grep -q -- '^run --rm' "$DOCKER_RUN_LOG" || fail 'manager gate must run the sandbox image probe'
grep -q -- '^run -d --rm' "$DOCKER_RUN_LOG" || fail 'manager must spawn a Pi runner after the backend gate succeeds'

# Missing sandbox image: fail closed before requesting a runner registration token.
(
  RUNNER_PREFIX=n150-pi-eph
  RUN_CHECK_SANDBOX_IMAGE=missing-sandbox:0.1.0
  MOUNT_PI_CONFIG=true
  RUN_CHECK_SANDBOX_VERIFIED=false
  docker() { return 1; }
  registration_token() { fail 'manager requested a token without a sandbox image'; }
  if spawn_runner >/dev/null 2>&1; then fail 'manager must refuse Pi runner startup when sandbox image is missing'; fi
)

printf 'runner autoscaler checks passed\n'

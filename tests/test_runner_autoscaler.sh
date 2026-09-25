#!/usr/bin/env bash
set -euo pipefail

export GH_ADMIN_TOKEN=test-token GITHUB_REPOSITORY=example/repo
source "$(dirname "$0")/../infra/github-runner-autoscaler/manager.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_failure() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }

api_get() {
  case "$1" in
    *first.yml*status=pending*) if [[ "${FIRST_PENDING_RESPONSE+x}" ]]; then printf '%s' "$FIRST_PENDING_RESPONSE"; else printf '%s' '{"total_count":1}'; fi ;;
    *second.yml*status=pending*) if [[ "${SECOND_PENDING_RESPONSE+x}" ]]; then printf '%s' "$SECOND_PENDING_RESPONSE"; else printf '%s' '{"total_count":0}'; fi ;;
    *first.yml*) if [[ "${FIRST_RESPONSE+x}" ]]; then printf '%s' "$FIRST_RESPONSE"; else printf '%s' '{"total_count":2}'; fi ;;
    *second.yml*)
      if [[ "${SECOND_FAIL:-0}" == 1 ]]; then return 22; fi
      if [[ "${SECOND_RESPONSE+x}" ]]; then printf '%s' "$SECOND_RESPONSE"; else printf '%s' '{"total_count":1}'; fi ;;
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
[[ "$(queued_jobs)" == 4 ]] || fail 'queued and pending run counts'

SECOND_FAIL=1
assert_failure queued_jobs
unset SECOND_FAIL

for invalid in 'null' '"abc"' '-1' '1.5' '"3"'; do
  SECOND_RESPONSE="{\"total_count\":$invalid}"
  assert_failure queued_jobs
done
SECOND_RESPONSE=''
unset SECOND_RESPONSE

SECOND_PENDING_RESPONSE='{"total_count":"1"}'
assert_failure queued_jobs
unset SECOND_PENDING_RESPONSE

FIRST_RESPONSE=''
assert_failure queued_jobs
unset FIRST_RESPONSE

CONTAINER_NAMES=$'n150-pi-eph-10\nother-manager-11'
[[ "$(active_containers)" == 1 ]] || fail 'container counting must use runner prefix'

DELETED_IDS="$(mktemp)"
trap 'rm -f "$DELETED_IDS"' EXIT
RUNNERS_RESPONSE='{"runners":[{"id":10,"name":"n150-pi-eph-10","status":"offline"},{"id":11,"name":"other-manager-11","status":"offline"},{"id":12,"name":"n150-pi-eph-12","status":"offline"}]}'
cleanup_stale_registrations
[[ "$(cat "$DELETED_IDS")" == "${API}/actions/runners/12" ]] || fail 'cleanup removed a live or unrelated registration'

RUNNERS_RESPONSE='{"runners":null}'
assert_failure cleanup_stale_registrations
[[ "$(wc -l < "$DELETED_IDS")" == 1 ]] || fail 'invalid runner list caused deletion'

RUNNERS_RESPONSE='{"runners":[{"id":13,"name":"n150-pi-eph-13","status":"offline"}]}'
DOCKER_FAIL=1
assert_failure cleanup_stale_registrations
assert_failure active_containers
[[ "$(wc -l < "$DELETED_IDS")" == 1 ]] || fail 'Docker failure caused deletion'
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
  docker() {
    case "$1" in
      ps) printf '%s\n' 'n150-pi-eph-busy' 'n150-pi-eph-idle' ;;
      stop) printf '%s\n' "$2" >> "$STOPPED_NAMES" ;;
      *) fail "unexpected Docker command: $1" ;;
    esac
  }
  sleep() { exit 0; }
  main > "$STATUS_LOG"
)
[[ "$(cat "$STOPPED_NAMES")" == 'n150-pi-eph-idle' ]] || fail 'only the surplus idle runner may be stopped'
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
[[ "$(model_start_capacity 0)" == "unknown unknown $MAX_RUNNERS" ]] || fail 'vLLM without a backlog admits runners'
STATUS_RESPONSE=$'vllm:num_requests_waiting{model_name="a"} 0\nvllm:num_requests_waiting{model_name="b"} 2\n'
[[ "$(model_start_capacity 0)" == 'unknown unknown 0' ]] || fail 'vLLM backlog defers runners'
STATUS_RESPONSE='vllm:num_requests_running 0'
assert_failure model_start_capacity 0

SECOND_FAIL=1
(
  spawn_runner() { fail 'spawned a runner after API failure'; }
  sleep() { exit 0; }
  main >/dev/null
)

printf 'runner autoscaler checks passed\n'

#!/usr/bin/env bash
set -euo pipefail

export GH_ADMIN_TOKEN=test-token GITHUB_REPOSITORY=example/repo
source "$(dirname "$0")/../infra/github-runner-autoscaler/manager.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_failure() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }

api_get() {
  case "$1" in
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
  [[ "$*" == *' -X DELETE '* ]] || fail "unexpected curl command"
  printf '%s\n' "${*: -1}" >> "$DELETED_IDS"
}

WORKFLOW_FILES=first.yml,second.yml
[[ "$(queued_jobs)" == 3 ]] || fail 'normal queue count'

SECOND_FAIL=1
assert_failure queued_jobs
unset SECOND_FAIL

for invalid in 'null' '"abc"' '-1' '1.5' '"3"'; do
  SECOND_RESPONSE="{\"total_count\":$invalid}"
  assert_failure queued_jobs
done
SECOND_RESPONSE=''
unset SECOND_RESPONSE

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

SECOND_FAIL=1
(
  spawn_runner() { fail 'spawned a runner after API failure'; }
  sleep() { exit 0; }
  main >/dev/null
)

printf 'runner autoscaler checks passed\n'

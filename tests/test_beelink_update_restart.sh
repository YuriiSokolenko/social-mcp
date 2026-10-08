#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/scripts/beelink-update-restart.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bash -n "$SCRIPT" || fail 'script must pass Bash syntax check'
help="$(bash "$SCRIPT" --help)" || fail '--help must succeed without root or host access'
grep -q -- '--dry-run' <<<"$help" || fail 'help must document dry-run'
grep -q -- '--force-busy' <<<"$help" || fail 'help must document force-busy'
if bash "$SCRIPT" --not-a-real-option >/dev/null 2>&1; then
  fail 'unknown options must return nonzero'
fi
grep -q 'worker-general.Dockerfile' "$SCRIPT" || fail 'general worker image must be built'
build_line="$(grep -n 'manager image build failed' "$SCRIPT" | head -1 | cut -d: -f1)"
stop_line="$(grep -n 'compose stop control-runner' "$SCRIPT" | head -1 | cut -d: -f1)"
[[ "$build_line" -lt "$stop_line" ]] || fail 'images must build before services stop'
grep -q 'latest-images.env' "$SCRIPT" || fail 'tracked image versions must override stale host tags in the staged config'
grep -q 'pull --ff-only origin dev' "$SCRIPT" || fail 'staging checkout must fast-forward to the latest origin/dev'
grep -q -- '--force-recreate' "$SCRIPT" || fail 'managed services must be recreated'
if grep -Eq 'compose down.*-v|docker (system|volume) prune|docker rm -f' "$SCRIPT"; then
  fail 'script must not delete volumes or indiscriminately remove containers'
fi
grep -q 'active/queued Actions work' "$SCRIPT" || fail 'busy-work guard must fail closed'
grep -q 'social-mcp.pi-runner=ephemeral' "$SCRIPT" || fail 'only labeled project ephemeral workers may be stopped'
grep -q -- '--pull never' "$SCRIPT" || fail 'Beszel must not pull mutable external images during this restart'
grep -Fq -- '--project-name "$RUNNER_COMPOSE_PROJECT"' "$SCRIPT" || fail 'runner Compose must reuse the active deployment project name'
grep -Fq -- '--project-name "$ZOEKT_COMPOSE_PROJECT"' "$SCRIPT" || fail 'Zoekt Compose must reuse its active deployment project name'
grep -q 'runner containers do not share one identifiable Compose project' "$SCRIPT" || fail 'runner project identity must be validated before recreation'
grep -q 'docker inspect pi-runner-manager' "$SCRIPT" || fail 'GitHub API checks must use the manager credential when gh is unavailable'
if grep -Eq 'for cmd .*\bgh\b|gh auth status|gh run list' "$SCRIPT"; then
  fail 'host GitHub CLI must not be required'
fi
grep -q 'unset RUNNERS_JSON RUNS_JSON GH_TOKEN' "$SCRIPT" || fail 'GitHub credential must be cleared after read-only preflight'
# Exercise the real post-restart verification path with Compose/Docker mocks.
# A missing control container must fail before image checks, even under set -u.
verification_block="$(sed -n '/^CONTROL_ID="$(compose ps -q control-runner)"$/,/^CONTROL_RUNNING_IMAGE=/p' "$SCRIPT")"
[[ "$verification_block" == *'CONTROL_RUNNING_IMAGE='* ]] || fail 'post-restart verification fixture cannot locate code block'
run_verification_fixture() (
  set -euo pipefail
  local control_id="$1"
  compose() {
    [[ "$*" == 'ps -q control-runner' ]] || return 1
    printf '%s\n' "$control_id"
  }
  docker() {
    [[ $# == 4 && "$1" == inspect && "$2" == --format ]] || return 1
    case "$3" in
      '{{.State.Status}}')
        case "$4" in
          pi-runner-manager|general-runner-manager|social-mcp-zoekt) printf 'running\n';;
          "$control_id") [[ -n "$control_id" ]] || return 1; printf 'running\n';;
          *) return 1;;
        esac;;
      '{{.Image}}') printf 'sha256:mock\n';;
      '{{.Config.Image}}')
        case "$4" in
          pi-runner-manager|general-runner-manager) printf 'n150/mock-manager:1\n';;
          "$control_id") [[ -n "$control_id" ]] || return 1; printf 'n150/mock-control:1\n';;
          *) return 1;;
        esac;;
      *) return 1;;
    esac
  }
  curl() { :; }
  log() { :; }
  die() { fail "$*"; }
  eval "$verification_block"
  [[ "$CONTROL_ID" == "$control_id" && "$CONTROL_RUNNING_IMAGE" == 'n150/mock-control:1' ]]
)
run_verification_fixture 'control-fixture-123' || fail 'valid control ID must pass post-restart verification'
# Require the early, actionable guard diagnostic. A later Docker inspect
# failure is not sufficient: it means the missing-ID guard was bypassed.
if missing_id_error="$(run_verification_fixture '' 2>&1)"; then
  fail 'missing control ID must fail post-restart verification'
fi
[[ "$missing_id_error" == *'could not identify control runner container after restart'* ]] || \
  fail 'missing control ID must fail at the explicit guard, not a later Docker inspect'
printf 'PASS: Beelink update/restart argument and safety checks\n'

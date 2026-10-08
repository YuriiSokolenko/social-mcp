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
grep -q 'docker inspect pi-runner-manager' "$SCRIPT" || fail 'GitHub API checks must use the manager credential when gh is unavailable'
if grep -Eq 'for cmd .*\bgh\b|gh auth status|gh run list' "$SCRIPT"; then
  fail 'host GitHub CLI must not be required'
fi
grep -q 'unset RUNNERS_JSON RUNS_JSON GH_TOKEN' "$SCRIPT" || fail 'GitHub credential must be cleared after read-only preflight'
printf 'PASS: Beelink update/restart argument and safety checks\n'

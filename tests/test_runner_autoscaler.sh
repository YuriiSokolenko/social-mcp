#!/usr/bin/env bash
set -euo pipefail

export GH_ADMIN_TOKEN=test-token GITHUB_REPOSITORY=example/repo
source "$(dirname "$0")/../infra/github-runner-autoscaler/manager.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_failure() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }


repo_root="$(cd "$(dirname "$0")/.." && pwd)"
control_compose="$(awk '/^  control-runner:/{capture=1} capture{if (/^volumes:/) exit; print}' "$repo_root/infra/github-runner-autoscaler/compose.yaml")"
control_dockerfile="$(cat "$repo_root/infra/github-runner-autoscaler/control-runner.Dockerfile")"
control_entrypoint="$(cat "$repo_root/infra/github-runner-autoscaler/control-runner-entrypoint.sh")"

grep -q '^  control-runner:$' "$repo_root/infra/github-runner-autoscaler/compose.yaml" || fail 'control runner service missing'
grep -q 'RUNNER_LABELS: .*n150,control' <<<"$control_compose" || fail 'control runner must register n150,control labels'
grep -q 'restart: unless-stopped' <<<"$control_compose" || fail 'control runner must survive host/container restarts'
grep -q 'cpus: 0.50' <<<"$control_compose" || fail 'control runner CPU limit missing'
grep -q 'mem_limit: 512m' <<<"$control_compose" || fail 'control runner memory limit missing'
grep -q 'pids_limit: 256' <<<"$control_compose" || fail 'control runner PID limit missing'
grep -q 'cap_drop:' <<<"$control_compose" && grep -q -- '- ALL' <<<"$control_compose" || fail 'control runner must drop the default capability set'
grep -q -- '- SETGID' <<<"$control_compose" || fail 'control runner needs only SETGID to launch the unprivileged worker'
grep -q -- '- SETUID' <<<"$control_compose" || fail 'control runner needs only SETUID to launch the unprivileged worker'
! grep -q 'SYS_ADMIN\|NET_ADMIN\|SYS_PTRACE' <<<"$control_compose" || fail 'control runner must not regain privileged capabilities'
grep -q 'no-new-privileges:true' <<<"$control_compose" || fail 'control runner no-new-privileges missing'
! grep -q '/var/run/docker.sock' <<<"$control_compose" || fail 'control runner must never receive Docker socket'
! grep -q 'MODEL_STATUS_URL\|PI_HOME\|PI_CONFIG\|MOUNT_PI_CONFIG' <<<"$control_compose" || fail 'control runner must not depend on Pi/model runtime'
grep -q '^FROM node:24-bookworm-slim$' <<<"$control_dockerfile" || fail 'control runner must use slim Debian/glibc base'
! grep -qi 'alpine\|docker-ce\|docker-compose' <<<"$control_dockerfile" || fail 'control runner image must stay free of Alpine and Docker tooling'
grep -q 'ACTIONS_RUNNER_VERSION=2.337.0' <<<"$control_dockerfile" || fail 'control runner Actions Runner version must be pinned'
grep -q 'ACTIONS_RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613' <<<"$control_dockerfile" || fail 'control runner archive checksum must be pinned'
grep -q 'unset GH_ADMIN_TOKEN' <<<"$control_entrypoint" || fail 'control jobs must not inherit repository-admin token'
grep -q 'env -u GH_ADMIN_TOKEN gosu runner ./bin/Runner.Listener run' <<<"$control_entrypoint" \
  || fail 'control runner must execute Runner.Listener directly to preserve upstream return codes'
! grep -q 'gosu runner ./run.sh\|RUNNER_MANUALLY_TRAP_SIG' <<<"$control_entrypoint" \
  || fail 'control runner must not hide listener failures behind run.sh/run-helper.sh'
! grep -q -- '--disableupdate' <<<"$control_entrypoint" || fail 'persistent control runner must keep GitHub self-update enabled'
grep -q 'gosu runner rm -f .runner .credentials .credentials_rsaparams' <<<"$control_entrypoint" \
  || fail 'stale registration cleanup must run as the runner user'
grep -q 'runner_api_healthy' <<<"$control_entrypoint" || fail 'control runner must gate destructive recovery on a healthy GitHub runners API'
grep -q 'CONTROL_REPAIR_COOLDOWN_SECONDS' <<<"$control_entrypoint" \
  || fail 'automatic re-registration must have a persistent cooldown'
! grep -q 'runner_registration_state\|per_page=100\|\.name == \$name' <<<"$control_entrypoint" \
  || fail 'control recovery must not make a pagination-sensitive name lookup'
grep -q 'configure_runner &' <<<"$control_entrypoint" \
  || fail 'first-time registration must run asynchronously so PID 1 can handle stop signals'
grep -q 'registration_pid' <<<"$control_entrypoint" && grep -q 'kill -INT --' <<<"$control_entrypoint" \
  || fail 'registration shutdown must signal its process group'
grep -q 'listener_pid' <<<"$control_entrypoint" && grep -q 'Runner.Listener process group' <<<"$control_entrypoint" \
  || fail 'runner shutdown must signal the listener/worker process group'
! grep -q 'remove-token\|config.sh remove' <<<"$control_entrypoint" \
  || fail 'normal persistent runner lifecycle must not deregister on stop'
trap_line="$(grep -n '^trap shutdown TERM INT$' <<<"$control_entrypoint" | cut -d: -f1)"
configure_line="$(grep -n '^if \[ ! -f \.runner \]; then$' <<<"$control_entrypoint" | cut -d: -f1)"
[[ -n "$trap_line" && -n "$configure_line" && "$trap_line" -lt "$configure_line" ]] \
  || fail 'control runner must install its stop trap before first-time registration starts'

# Execute the control entrypoint against fake config.sh/Runner.Listener
# processes. Node fakes handle SIGINT explicitly, matching Runner.Listener's
# Ctrl-C behavior instead of Bash background-job signal semantics.
control_harness="$(mktemp -d)"
control_pid=""

cleanup_control_harness() {
  if [ -n "${control_pid:-}" ]; then
    kill -TERM "${control_pid}" 2>/dev/null || true
    for _ in {1..100}; do
      kill -0 "${control_pid}" 2>/dev/null || break
      sleep 0.02
    done
    kill -KILL "${control_pid}" 2>/dev/null || true
    wait "${control_pid}" 2>/dev/null || true
    control_pid=""
  fi
  rm -rf "${control_harness:-}"
}
trap cleanup_control_harness EXIT

mkdir -p "$control_harness/basebin"
cat > "$control_harness/basebin/gosu" <<'GOSU'
#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
GOSU
chmod +x "$control_harness/basebin/gosu"

wait_for_text() {
  local file="$1" pattern="$2"
  for _ in {1..150}; do
    grep -q "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.02
  done
  return 1
}

wait_control_exit() {
  local label="$1"
  for _ in {1..100}; do
    kill -0 "$control_pid" 2>/dev/null || {
      wait "$control_pid" 2>/dev/null || true
      control_pid=""
      return 0
    }
    sleep 0.02
  done
  kill -KILL "$control_pid" 2>/dev/null || true
  wait "$control_pid" 2>/dev/null || true
  control_pid=""
  fail "$label: control entrypoint did not stop promptly"
}

stop_control_case() {
  [ -n "${control_pid:-}" ] || return 0
  kill -TERM "$control_pid" 2>/dev/null || true
  wait_control_exit "$1"
}

write_fake_listener() {
  local path="$1"
  cat > "$path" <<'LISTENER'
#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const mode = process.env.LISTENER_MODE;
if (mode === 'exit1') process.exit(1);
if (mode === 'exit5') process.exit(5);
if (mode === 'exit7') process.exit(7);
if (mode !== 'wait') process.exit(97);

const childSource = [
  "const fs=require('node:fs');",
  "process.on('SIGINT',()=>{fs.writeFileSync(process.env.CHILD_FORWARDED,'child');process.exit(0);});",
  "fs.writeFileSync(process.env.RUN_READY,'ready');",
  "setInterval(()=>{},1000);",
].join('');
spawn(process.execPath, ['-e', childSource], {
  stdio: 'ignore',
  env: process.env,
});

process.on('SIGINT', () => {
  fs.writeFileSync(process.env.SIGNAL_FORWARDED, 'parent');
  setTimeout(() => process.exit(0), 20);
});
setInterval(() => {}, 1000);
LISTENER
  chmod +x "$path"
}

start_control_case() {
  local case_name="$1" listener_mode="$2" api_mode="$3"
  local case_dir="$control_harness/$case_name"
  mkdir -p "$case_dir/runner/bin" "$case_dir/bin"
  cp "$control_harness/basebin/gosu" "$case_dir/bin/gosu"
  : > "$case_dir/curl.log"
  printf 'registered\n' > "$case_dir/runner/.runner"
  printf 'credentials\n' > "$case_dir/runner/.credentials"
  printf 'rsa\n' > "$case_dir/runner/.credentials_rsaparams"

  cat > "$case_dir/bin/curl" <<CURL
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$case_dir/curl.log"
if [[ "\$*" == *'/registration-token'* ]]; then
  printf '%s\n' '{"token":"registration-token"}'
  exit 0
fi
case "$api_mode" in
  error) exit 22 ;;
  healthy) printf '%s\n' '{"runners":[]}' ;;
  *) exit 88 ;;
esac
CURL
  chmod +x "$case_dir/bin/curl"

  cat > "$case_dir/runner/config.sh" <<'CONFIG'
#!/usr/bin/env bash
set -euo pipefail
printf 'registered\n' > .runner
printf 'credentials\n' > .credentials
printf 'rsa\n' > .credentials_rsaparams
CONFIG
  chmod +x "$case_dir/runner/config.sh"
  write_fake_listener "$case_dir/runner/bin/Runner.Listener"

  LISTENER_MODE="$listener_mode" \
    RUN_READY="$case_dir/ready" \
    SIGNAL_FORWARDED="$case_dir/forwarded" \
    CHILD_FORWARDED="$case_dir/child-forwarded" \
    PATH="$case_dir/bin:$PATH" \
    RUNNER_HOME="$case_dir/runner" \
    GH_ADMIN_TOKEN=test-token \
    GITHUB_REPOSITORY=example/repo \
    CONTROL_RETRY_SECONDS=1 \
    CONTROL_REPAIR_COOLDOWN_SECONDS=60 \
    bash "$repo_root/infra/github-runner-autoscaler/control-runner-entrypoint.sh" \
    >"$case_dir/stdout" 2>"$case_dir/stderr" &
  control_pid=$!
  CASE_DIR="$case_dir"
}

# Return code 1 must stay visible. An API outage is non-destructive.
start_control_case api-error exit1 error
wait_for_text "$CASE_DIR/stderr" 'preserving credentials' || fail 'api-error: recovery warning not observed'
[[ -f "$CASE_DIR/runner/.runner" && -f "$CASE_DIR/runner/.credentials" ]] \
  || fail 'API reconciliation failure must preserve known local registration'
stop_control_case api-error

# Return code 5 is a session/credential failure. One healthy repair is allowed;
# the persisted cooldown prevents a new runner ID on every subsequent cycle.
start_control_case bounded-repair exit5 healthy
wait_for_text "$CASE_DIR/stderr" 'inside cooldown' || fail 'bounded-repair: cooldown was not reached after repair'
[[ -f "$CASE_DIR/runner/.runner" && -f "$CASE_DIR/runner/.credentials" ]] \
  || fail 'bounded repair must leave the fresh registration in place'
[[ -f "$CASE_DIR/runner/.control-last-repair" ]] || fail 'bounded repair must persist its cooldown marker'
registration_posts="$(grep -c '/registration-token' "$CASE_DIR/curl.log" || true)"
[[ "$registration_posts" == 1 ]] || fail "bounded repair expected one registration token POST, got $registration_posts"
stop_control_case bounded-repair

# Version-deprecated code 7 is not a credential problem and must never cause
# registration churn. The long backoff must still be interruptible by TERM.
start_control_case deprecated exit7 healthy
wait_for_text "$CASE_DIR/stderr" 'runner version is deprecated' || fail 'deprecated: version warning not observed'
[[ -f "$CASE_DIR/runner/.runner" && -f "$CASE_DIR/runner/.credentials" ]] \
  || fail 'deprecated runner version must preserve registration'
[[ ! -s "$CASE_DIR/curl.log" ]] || fail 'deprecated runner version must not call the GitHub runners API'
stop_control_case deprecated

# Normal Docker stop SIGINTs the entire listener process group. The fake
# listener and its simulated worker both record receipt of that signal.
start_control_case normal-stop wait error
for _ in {1..150}; do [ -f "$CASE_DIR/ready" ] && break; sleep 0.02; done
[ -f "$CASE_DIR/ready" ] || fail 'normal-stop: listener never started'
kill -TERM "$control_pid"
wait_control_exit normal-stop
[[ -f "$CASE_DIR/forwarded" && -f "$CASE_DIR/child-forwarded" ]] \
  || fail 'normal stop must signal the entire listener/worker process group'
[[ -f "$CASE_DIR/runner/.runner" && -f "$CASE_DIR/runner/.credentials" ]] \
  || fail 'normal Docker stop must preserve persistent runner registration'
[[ ! -s "$CASE_DIR/curl.log" ]] || fail 'normal Docker stop must not require GitHub API access'

# Failed first registration must clear partial local files before retrying.
failed_registration="$control_harness/failed-registration"
mkdir -p "$failed_registration/runner/bin" "$failed_registration/bin"
cp "$control_harness/basebin/gosu" "$failed_registration/bin/gosu"
cat > "$failed_registration/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'/registration-token'* ]]; then
  printf '%s\n' '{"token":"registration-token"}'
else
  printf '%s\n' '{"runners":[]}'
fi
CURL
cat > "$failed_registration/runner/config.sh" <<'CONFIG'
#!/usr/bin/env bash
set -euo pipefail
printf 'partial\n' > .runner
printf 'partial\n' > .credentials
exit 9
CONFIG
write_fake_listener "$failed_registration/runner/bin/Runner.Listener"
chmod +x "$failed_registration/bin/curl" "$failed_registration/runner/config.sh"

PATH="$failed_registration/bin:$PATH" \
  RUNNER_HOME="$failed_registration/runner" \
  GH_ADMIN_TOKEN=test-token \
  GITHUB_REPOSITORY=example/repo \
  CONTROL_RETRY_SECONDS=1 \
  bash "$repo_root/infra/github-runner-autoscaler/control-runner-entrypoint.sh" \
  >"$failed_registration/stdout" 2>"$failed_registration/stderr" &
control_pid=$!
wait_for_text "$failed_registration/stderr" 'registration failed status=9' || fail 'failed-registration: failure not observed'
[[ ! -e "$failed_registration/runner/.runner" && ! -e "$failed_registration/runner/.credentials" ]] \
  || fail 'failed first registration must clear partial local credentials'
stop_control_case failed-registration

# TERM during first registration must stop the entire config process group,
# wait for it, clear partial files, and never launch the listener.
registration_case="$control_harness/registration-stop"
mkdir -p "$registration_case/runner/bin" "$registration_case/bin"
cp "$control_harness/basebin/gosu" "$registration_case/bin/gosu"
cat > "$registration_case/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'/registration-token'* ]]; then
  printf '%s\n' '{"token":"registration-token"}'
else
  exit 88
fi
CURL
cat > "$registration_case/runner/config.sh" <<'CONFIG'
#!/usr/bin/env bash
set -euo pipefail
printf 'partial\n' > .runner
printf 'partial\n' > .credentials
node -e '
  const fs=require("node:fs");
  fs.writeFileSync(process.env.CONFIG_PID_FILE,String(process.pid));
  process.on("SIGINT",()=>{fs.writeFileSync(process.env.CONFIG_STOPPED,"stopped");process.exit(130);});
  fs.writeFileSync(process.env.CONFIG_READY,"ready");
  setInterval(()=>{},1000);
'
CONFIG
cat > "$registration_case/runner/bin/Runner.Listener" <<'LISTENER'
#!/usr/bin/env bash
touch "$RUN_STARTED"
exit 0
LISTENER
chmod +x "$registration_case/bin/curl" "$registration_case/runner/config.sh" "$registration_case/runner/bin/Runner.Listener"

CONFIG_READY="$registration_case/config-ready" \
  CONFIG_PID_FILE="$registration_case/config-pid" \
  CONFIG_STOPPED="$registration_case/config-stopped" \
  RUN_STARTED="$registration_case/run-started" \
  PATH="$registration_case/bin:$PATH" \
  RUNNER_HOME="$registration_case/runner" \
  GH_ADMIN_TOKEN=test-token \
  GITHUB_REPOSITORY=example/repo \
  bash "$repo_root/infra/github-runner-autoscaler/control-runner-entrypoint.sh" \
  >"$registration_case/stdout" 2>"$registration_case/stderr" &
control_pid=$!
for _ in {1..150}; do [ -f "$registration_case/config-ready" ] && break; sleep 0.02; done
[ -f "$registration_case/config-ready" ] || fail 'registration-stop: config child never started'
config_pid="$(cat "$registration_case/config-pid")"
kill -TERM "$control_pid"
wait_control_exit registration-stop
[[ -f "$registration_case/config-stopped" ]] || fail 'registration-stop: config process group did not receive SIGINT'
! kill -0 "$config_pid" 2>/dev/null || fail 'registration-stop: config child was orphaned'
[[ ! -e "$registration_case/runner/.runner" && ! -e "$registration_case/runner/.credentials" ]] \
  || fail 'registration-stop: interrupted registration left partial local state'
[[ ! -e "$registration_case/run-started" ]] || fail 'registration-stop: listener started after interrupted registration'

rm -rf "$control_harness"
control_harness=""
trap - EXIT

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
  PIP_CACHE_HOST_DIR=/var/cache/social-mcp/pip
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
grep -q -- 'type=bind,source=/var/cache/social-mcp/pip,target=/home/runner/.cache/pip' "$DOCKER_RUN_LOG" || fail 'general runner must mount the optional host pip cache'
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
  PIP_CACHE_HOST_DIR=
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
grep -q -- '/home/runner/.cache/pip' "$DOCKER_RUN_LOG" && fail 'Pi runner must not receive the general-pool pip cache'
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


# #401: daemon metadata corruption quarantines the entire general pool before
# requesting a token; repeated scheduling remains stopped until two healthy polls.
(
  MOUNT_DOCKER_SOCKET=true
  MOUNT_PI_CONFIG=false
  DOCKER_QUARANTINED=false
  DOCKER_HEALTHY_POLLS=0
  HEALTH_FAIL=true
  sleep() { [[ "$1" == "$DOCKER_HEALTH_RETRY_SECONDS" ]] || fail "unexpected health retry delay: $1"; }
  run_with_timeout() {
    shift
    if [[ "$*" == 'docker system df' && "$HEALTH_FAIL" == true ]]; then
      echo 'Error response from daemon: rw layer snapshot not found for container 37d2be901d24' >&2
      return 1
    fi
  }
  registration_token() { fail 'requested runner token on quarantined host'; }
  if spawn_runner > "$STATUS_LOG" 2>&1; then fail 'corrupt daemon accepted work'; fi
  [[ "$DOCKER_QUARANTINED" == true ]] || fail 'host must be quarantined'
  grep -q 'infra_error code=DOCKER_METADATA_CORRUPTION' "$STATUS_LOG" || fail 'corruption lacks actionable infrastructure classification'
  if general_daemon_health >/dev/null; then fail 'unrepaired daemon accepted work'; fi
  HEALTH_FAIL=false
  if general_daemon_health >/dev/null; then fail 'one healthy poll released quarantine too early'; fi
  general_daemon_health >/dev/null || fail 'healthy daemon did not recover'
  [[ "$DOCKER_QUARANTINED" == false ]] || fail 'quarantine not released after repair'
)

# #437: quarantine and recovery leave durable evidence, once per transition.
(
  MOUNT_DOCKER_SOCKET=true
  DOCKER_QUARANTINED=false
  DOCKER_HEALTHY_POLLS=0
  HEALTH_FAIL=true
  INFRA_EVIDENCE_DIR="$(mktemp -d)"
  trap 'rm -rf "$INFRA_EVIDENCE_DIR"' EXIT
  sleep() { :; }
  run_with_timeout() {
    shift
    if [[ "$*" == 'docker system df' && "$HEALTH_FAIL" == true ]]; then
      echo 'Error response from daemon: rw layer snapshot not found for container 37d2be901d24' >&2
      return 1
    fi
    if [[ "$*" == docker\ ps* ]]; then echo '37d2be901d24 n150-gen-eph-1 Exited (0)'; fi
    return 0
  }
  general_daemon_health >/dev/null 2>&1 || true
  general_daemon_health >/dev/null 2>&1 || true
  [[ "$(grep -c "" "$INFRA_EVIDENCE_DIR/events.jsonl")" == 1 ]] || fail 'quarantine evidence must be recorded once per transition'
  jq -e '.event == "quarantined" and (.detail | contains("DOCKER_METADATA_CORRUPTION")) and (.containers | contains("n150-gen-eph-1"))' \
    "$INFRA_EVIDENCE_DIR/events.jsonl" >/dev/null || fail 'quarantine evidence lacks code or container snapshot'
  HEALTH_FAIL=false
  general_daemon_health >/dev/null 2>&1 || true
  general_daemon_health >/dev/null 2>&1 || fail 'daemon did not recover'
  [[ "$(jq -r .event "$INFRA_EVIDENCE_DIR/events.jsonl" | tail -n 1)" == recovered ]] || fail 'recovery evidence missing'
  # An unwritable evidence location must never change health results.
  INFRA_EVIDENCE_DIR=/proc/nonexistent/evidence
  record_infra_evidence quarantined x >/dev/null 2>&1 || fail 'evidence failure must be non-fatal'
)

# #437: a fresh named volume is root-owned and not writable by the worker's UID.
# Initialisation must open it before any event, without a quarantine to trigger it.
(
  INFRA_EVIDENCE_DIR="$(mktemp -d)"
  trap 'chmod 755 "$INFRA_EVIDENCE_DIR"; rm -rf "$INFRA_EVIDENCE_DIR"' EXIT
  chmod 0555 "$INFRA_EVIDENCE_DIR"
  [[ ! -w "$INFRA_EVIDENCE_DIR" || "$(id -u)" == 0 ]] || fail 'precondition: dir should start non-writable'
  init_infra_evidence_dir
  [[ "$(ls -ld "$INFRA_EVIDENCE_DIR" | cut -c1-10)" == drwxrwxrwt ]] || fail 'evidence dir not world-writable after init'
  [[ -w "$INFRA_EVIDENCE_DIR" ]] || fail 'evidence dir not writable after init'
)

# A single transient Docker health-check failure is retried after a short delay
# before the manager quarantines the pool. Each check gets at most one retry.
(
  MOUNT_DOCKER_SOCKET=true
  DOCKER_QUARANTINED=false
  DOCKER_HEALTHY_POLLS=0
  CHECK_LOG="$(mktemp)"
  trap 'rm -f "$CHECK_LOG"' EXIT
  sleep() { [[ "$1" == "$DOCKER_HEALTH_RETRY_SECONDS" ]] || fail "unexpected health retry delay: $1"; }
  run_with_timeout() {
    shift
    printf '%s\n' "$*" >> "$CHECK_LOG"
    local calls
    calls="$(grep -c -Fx "$*" "$CHECK_LOG")"
    if [ "$calls" -eq 1 ]; then
      echo 'transient daemon response' >&2
      return 1
    fi
  }
  general_daemon_health || fail 'transient Docker health error quarantined a healthy pool'
  [[ "$(grep -c -Fx 'docker info' "$CHECK_LOG")" == 2 ]] || fail 'docker info did not get exactly one retry'
  [[ "$(grep -c -Fx 'docker system df' "$CHECK_LOG")" == 2 ]] || fail 'docker system df did not get exactly one retry'
  [[ "$DOCKER_QUARANTINED" == false ]] || fail 'successful health retries left pool quarantined'
)

# The main scheduler must fail closed even when containers/runner state is unavailable.
(
  MOUNT_DOCKER_SOCKET=true
  run_with_timeout() { echo 'rw layer snapshot not found' >&2; return 1; }
  cleanup_stale_registrations() { fail 'unhealthy poll attempted cleanup'; }
  spawn_runner() { fail 'unhealthy main loop scheduled a job'; }
  sleep() { [[ "$1" == "$DOCKER_HEALTH_RETRY_SECONDS" ]] && return 0; exit 0; }
  main >/dev/null
)

# Quarantine removes only this pool's idle registrations; busy and unrelated
# registrations are preserved even when Docker metadata inspection is broken.
(
  RUNNER_PREFIX=n150-gen-eph
  api_get() { printf '%s' '{"runners":[{"id":10,"name":"n150-gen-eph-idle","busy":false,"labels":[{"name":"general"}]},{"id":11,"name":"n150-gen-eph-busy","busy":true,"labels":[{"name":"general"}]},{"id":12,"name":"n150-pi-eph-idle","busy":false,"labels":[{"name":"pi-agent"}]},{"id":13,"name":"n150-gen-eph-model","busy":false,"labels":[{"name":"pi-agent"}]}]}'; }
  : > "$DELETED_IDS"
  quarantine_general_runners >/dev/null
  [[ "$(cat "$DELETED_IDS")" == "${API}/actions/runners/10" ]] || fail 'quarantine touched a busy runner or another pool'
)
# A runner becoming busy between list and DELETE must not stop quarantine.
(
  RUNNER_PREFIX=n150-gen-eph
  api_get() { printf '%s' '{"runners":[{"id":20,"name":"n150-gen-eph-race","busy":false,"labels":[{"name":"general"}]},{"id":21,"name":"n150-gen-eph-idle","busy":false,"labels":[{"name":"general"}]}]}'; }
  curl() {
    if [[ "${*: -1}" == */20 ]]; then return 22; fi
    printf '%s\n' "${*: -1}" >> "$DELETED_IDS"
  }
  : > "$DELETED_IDS"
  quarantine_general_runners >/dev/null
  [[ "$(cat "$DELETED_IDS")" == "${API}/actions/runners/21" ]] || fail 'busy race stopped the quarantine loop'
)

# The worker retries a transient daemon metadata check once before registration,
# and still refuses to register when the retry also fails.
(
  worker_root="$(mktemp -d)"
  trap 'rm -rf "$worker_root"' EXIT
  worker_bin="$worker_root/bin"
  runner_home="$worker_root/runner"
  mkdir -p "$worker_bin" "$runner_home/actions-runner"
  cat > "$worker_bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  info) check=info ;;
  'system df') check=metadata ;;
  *) exit 88 ;;
esac
if [[ "${DOCKER_FAIL_METADATA:-false}" == true && "$check" == metadata ]]; then
  echo 'transient snapshot race' >&2
  exit 1
fi
if [[ "${DOCKER_FAIL_FIRST:-false}" == true ]]; then
  count="$(grep -c -Fx "$*" "$DOCKER_LOG")"
  if [[ "$count" == 1 ]]; then
    echo 'transient snapshot race' >&2
    exit 1
  fi
fi
DOCKER
  cat > "$worker_bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$SLEEP_LOG"
SLEEP
  cat > "$worker_bin/timeout" <<'TIMEOUT'
#!/usr/bin/env bash
shift
exec "$@"
TIMEOUT
  cat > "$runner_home/actions-runner/config.sh" <<'CONFIG'
#!/usr/bin/env bash
touch "$REGISTER_LOG"
CONFIG
  cat > "$runner_home/actions-runner/run.sh" <<'RUN'
#!/usr/bin/env bash
touch "$RUN_LOG"
RUN
  chmod +x "$worker_bin/docker" "$worker_bin/sleep" "$worker_bin/timeout" "$runner_home/actions-runner/config.sh" "$runner_home/actions-runner/run.sh"
  repo_root="$(cd "$(dirname "$0")/.." && pwd)"
  worker_script="$repo_root/infra/github-runner-autoscaler/worker-entrypoint.sh"
  export PATH="$worker_bin:$PATH" RUNNER_HOME="$runner_home" RUNNER_TOKEN=test-token GITHUB_REPOSITORY=example/repo
  export RUNNER_NAME=n150-gen-eph-test RUNNER_LABELS=n150,general
  export DOCKER_LOG="$worker_root/docker.log" SLEEP_LOG="$worker_root/sleep.log"
  export REGISTER_LOG="$worker_root/registered" RUN_LOG="$worker_root/ran"

  if ! DOCKER_FAIL_FIRST=true bash "$worker_script" >"$worker_root/pass.stdout" 2>"$worker_root/pass.stderr"; then
    cat "$worker_root/pass.stderr" >&2
    cat "$DOCKER_LOG" >&2
    fail 'worker rejected a transient Docker health failure'
  fi
  [[ "$(grep -c -Fx info "$DOCKER_LOG")" == 2 ]] || fail 'worker did not retry docker info exactly once'
  [[ "$(grep -c -Fx 'system df' "$DOCKER_LOG")" == 2 ]] || fail 'worker did not retry docker system df exactly once'
  [[ "$(wc -l < "$SLEEP_LOG")" -eq 2 ]] || fail 'worker did not delay before each health retry'
  [[ -f "$REGISTER_LOG" && -f "$RUN_LOG" ]] || fail 'worker did not register after healthy retries'

  : > "$DOCKER_LOG"
  : > "$SLEEP_LOG"
  rm -f "$REGISTER_LOG" "$RUN_LOG"
  if DOCKER_FAIL_METADATA=true bash "$worker_script" >"$worker_root/fail.stdout" 2>"$worker_root/fail.stderr"; then
    fail 'worker registered despite persistent metadata failure'
  fi
  [[ "$(grep -c -Fx 'system df' "$DOCKER_LOG")" == 2 ]] || fail 'worker did not retry persistent metadata failure exactly once'
  grep -q 'infra_error DOCKER_METADATA_CORRUPTION' "$worker_root/fail.stderr" || fail 'persistent metadata failure was not classified'
  [[ ! -e "$REGISTER_LOG" ]] || fail 'worker registered on an unhealthy daemon'

  # #437: with an evidence volume, health failures and runner diagnostics outlive the container.
  export INFRA_EVIDENCE_DIR="$worker_root/evidence"
  mkdir -p "$INFRA_EVIDENCE_DIR" "$runner_home/actions-runner/_diag"
  if DOCKER_FAIL_METADATA=true bash "$worker_script" >/dev/null 2>&1; then fail 'worker registered despite metadata failure'; fi
  grep -q 'DOCKER_METADATA_CORRUPTION' "$INFRA_EVIDENCE_DIR/worker-events.log" || fail 'worker health failure left no evidence'
  printf 'Set up job failed\n' > "$runner_home/actions-runner/_diag/Worker_1.log"
  printf '#!/usr/bin/env bash\ntouch "$RUN_LOG"\nexit 3\n' > "$runner_home/actions-runner/run.sh"
  status=0
  bash "$worker_script" >/dev/null 2>&1 || status=$?
  [[ "$status" == 3 ]] || fail "worker must propagate the runner exit status, got $status"
  grep -q 'Set up job failed' "$INFRA_EVIDENCE_DIR/n150-gen-eph-test-worker-diag.log" || fail 'runner diagnostics were not preserved'
  grep -q 'runner exited status=3' "$INFRA_EVIDENCE_DIR/worker-events.log" || fail 'runner exit status was not recorded'
  unset INFRA_EVIDENCE_DIR
)
printf 'runner autoscaler checks passed\n'

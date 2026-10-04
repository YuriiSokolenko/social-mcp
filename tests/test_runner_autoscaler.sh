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
grep -q 'stop_grace_period: 120s' <<<"$control_compose" || fail 'control runner must allow bounded update/child shutdown'
grep -q 'cpus: 1.00' <<<"$control_compose" || fail 'control runner CPU limit missing'
grep -q 'mem_limit: 1g' <<<"$control_compose" || fail 'control runner memory limit missing'
grep -q 'pids_limit: 512' <<<"$control_compose" || fail 'control runner PID limit missing'
grep -q 'control-runner-state:/home/runner/actions-runner' <<<"$control_compose" || fail 'control runner root must use persistent named volume'
grep -q 'CONTROL_RUNNER_STATE_VOLUME.*social-mcp-control-runner-state' "$repo_root/infra/github-runner-autoscaler/compose.yaml" || fail 'control runner persistent volume declaration missing'
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
grep -q 'ENV ACTIONS_RUNNER_BASELINE_VERSION=' <<<"$control_dockerfile" || fail 'control image must expose its verified runner baseline version'
grep -q '/opt/actions-runner-baseline' <<<"$control_dockerfile" || fail 'control image must keep baseline package outside the persistent runner root'
grep -q 'cp -a /opt/actions-runner-baseline/. /home/runner/actions-runner/' <<<"$control_dockerfile" || fail 'new control volume must be seeded with the runner package'

grep -q 'unset GH_ADMIN_TOKEN' <<<"$control_entrypoint" || fail 'control jobs must not inherit repository-admin token'
grep -q 'gosu runner ./bin/Runner.Listener run' <<<"$control_entrypoint" \
  || fail 'control runner must execute Runner.Listener directly to preserve upstream return codes'
! grep -q 'gosu runner ./run.sh\|RUNNER_MANUALLY_TRAP_SIG\|env -u GH_ADMIN_TOKEN' <<<"$control_entrypoint" \
  || fail 'control runner must not hide listener failures behind run.sh or redundant environment wrappers'
! grep -q -- '--disableupdate' <<<"$control_entrypoint" || fail 'persistent control runner must keep GitHub self-update enabled'
grep -q 'registration_complete' <<<"$control_entrypoint" && grep -q '\[ -s .runner \].*\[ -s .credentials \]' <<<"$control_entrypoint" \
  || fail 'control startup must reject half-written registration state'
grep -q 'restore_runtime_baseline' <<<"$control_entrypoint" && grep -q 'ACTIONS_RUNNER_BASELINE_VERSION' <<<"$control_entrypoint" \
  || fail 'persisted runner root must be recoverable/upgradable from the image baseline'
grep -q 'gosu runner rm -f .runner .credentials .credentials_rsaparams' <<<"$control_entrypoint" \
  || fail 'registration cleanup must run as the runner user'
grep -q 'runner_api_healthy' <<<"$control_entrypoint" || fail 'credential repair must gate destructive recovery on a healthy runners API'
grep -q 'credential_failures' <<<"$control_entrypoint" && grep -q 'retrying once with existing credentials before repair' <<<"$control_entrypoint" \
  || fail 'listener credential/session failure must retry before re-registration'
grep -q 'CONTROL_REPAIR_COOLDOWN_SECONDS' <<<"$control_entrypoint" \
  || fail 'automatic re-registration must have a persistent cooldown'
grep -q 'mark_repair' <<<"$control_entrypoint" && grep -q 'failed to persist repair cooldown' <<<"$control_entrypoint" \
  || fail 'repair marker writes must fail closed instead of aborting PID 1'
grep -q 'interruptible_sleep' <<<"$control_entrypoint" && grep -q 'sleep_pid' <<<"$control_entrypoint" \
  || fail 'control runner backoff sleeps must remain interruptible by Docker stop'
grep -q 'stop_process_group' <<<"$control_entrypoint" && grep -q 'CONTROL_CHILD_STOP_WAIT_SECONDS' <<<"$control_entrypoint" \
  || fail 'control runner child shutdown must be bounded'
grep -q 'launch_in_progress' <<<"$control_entrypoint" && grep -q 'shutdown_requested' <<<"$control_entrypoint" && grep -q 'complete_launch' <<<"$control_entrypoint" \
  || fail 'signals arriving between child launch and PID capture must be deferred until the PID is owned'
grep -q 'CONTROL_UPDATE_SHUTDOWN_WAIT_SECONDS' <<<"$control_entrypoint" && grep -q 'update_waiting' <<<"$control_entrypoint" \
  || fail 'control runner shutdown must protect an in-flight self-update'
! grep -q 'runner_registration_state\|per_page=100\|\.name == \$name' <<<"$control_entrypoint" \
  || fail 'control recovery must not make a pagination-sensitive name lookup'
! grep -q 'remove-token\|config.sh remove' <<<"$control_entrypoint" \
  || fail 'normal persistent runner lifecycle must not deregister on stop'
trap_line="$(grep -n '^trap shutdown TERM INT$' <<<"$control_entrypoint" | cut -d: -f1)"
loop_line="$(grep -n '^while true; do$' <<<"$control_entrypoint" | head -n 1 | cut -d: -f1)"
[[ -n "$trap_line" && -n "$loop_line" && "$trap_line" -lt "$loop_line" ]] \
  || fail 'control runner must install its stop trap before registration/listener work starts'

# Execute the control entrypoint against fake config.sh/Runner.Listener
# processes. The fake listener preserves upstream return codes and supports
# version probes, update completion, and process-group signal checks.
control_harness="$(mktemp -d)"
control_pid=""

cleanup_control_harness() {
  if [ -n "${control_pid:-}" ]; then
    kill -TERM "${control_pid}" 2>/dev/null || true
    for _ in {1..150}; do
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
  for _ in {1..200}; do
    grep -q "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.02
  done
  return 1
}

wait_for_file() {
  local file="$1"
  for _ in {1..200}; do
    [ -e "$file" ] && return 0
    sleep 0.02
  done
  return 1
}

wait_control_exit() {
  local label="$1"
  for _ in {1..150}; do
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
  local label="$1"
  [ -n "${control_pid:-}" ] || return 0
  kill -TERM "$control_pid" 2>/dev/null || true
  wait_control_exit "$label"
}

write_fake_runtime() {
  local root="$1" version="$2"
  mkdir -p "$root/bin"

  cat > "$root/config.sh" <<'CONFIG'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CONFIG_LOG"
case "${CONFIG_MODE:-success}" in
  success)
    printf 'registered\n' > .runner
    printf 'credentials\n' > .credentials
    printf 'rsa\n' > .credentials_rsaparams
    ;;
  fail)
    printf 'partial\n' > .runner
    printf 'partial\n' > .credentials
    exit 9
    ;;
  wait)
    printf 'partial\n' > .runner
    printf 'partial\n' > .credentials
    exec node -e '
      const fs=require("node:fs");
      fs.writeFileSync(process.env.CONFIG_PID_FILE,String(process.pid));
      process.on("SIGINT",()=>{fs.writeFileSync(process.env.CONFIG_STOPPED,"stopped");process.exit(130);});
      fs.writeFileSync(process.env.CONFIG_READY,"ready");
      setInterval(()=>{},1000);
    '
    ;;
  *)
    exit 98
    ;;
esac
CONFIG
  chmod +x "$root/config.sh"

  cat > "$root/bin/Runner.Listener" <<'LISTENER'
#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const version = '__VERSION__';

if (process.argv.includes('--version')) {
  process.stdout.write(version + '\n');
  process.exit(0);
}

const sequence = (process.env.LISTENER_SEQUENCE || 'wait').split(',');
const indexFile = process.env.LISTENER_INDEX_FILE;
let index = 0;
try { index = Number(fs.readFileSync(indexFile, 'utf8')) || 0; } catch {}
const mode = sequence[Math.min(index, sequence.length - 1)];
fs.writeFileSync(indexFile, String(index + 1));

if (/^[0-7]$/.test(mode)) {
  const code = Number(mode);
  if (code === 3 || code === 4) {
    const delay = Number(process.env.UPDATE_DELAY_MS || 20);
    const childSource = [
      "const fs=require('node:fs');",
      "setTimeout(()=>{fs.writeFileSync('update.finished','done');fs.writeFileSync(process.env.UPDATE_DONE,'done');process.exit(0);}," + delay + ");",
    ].join('');
    spawn(process.execPath, ['-e', childSource], { stdio: 'ignore', env: process.env });
  }
  process.exit(code);
}

if (mode === '97') process.exit(97);
if (mode !== 'wait') process.exit(96);

const childSource = [
  "const fs=require('node:fs');",
  "process.on('SIGINT',()=>{fs.writeFileSync(process.env.CHILD_FORWARDED,'child');process.exit(0);});",
  "fs.writeFileSync(process.env.RUN_READY,'ready');",
  "setInterval(()=>{},1000);",
].join('');
spawn(process.execPath, ['-e', childSource], { stdio: 'ignore', env: process.env });
process.on('SIGINT', () => {
  fs.writeFileSync(process.env.SIGNAL_FORWARDED, 'parent');
  setTimeout(() => process.exit(0), 20);
});
setInterval(() => {}, 1000);
LISTENER
  sed -i "s/__VERSION__/$version/" "$root/bin/Runner.Listener"
  chmod +x "$root/bin/Runner.Listener"
}

start_control_case() {
  local case_name="$1" sequence="$2" api_mode="$3" registration_mode="${4:-complete}" config_mode="${5:-success}"
  local runtime_version="${6:-2.337.0}" retry_seconds="${7:-0}" update_delay_ms="${8:-20}"
  local case_dir="$control_harness/$case_name"

  mkdir -p "$case_dir/runner" "$case_dir/baseline" "$case_dir/bin"
  cp "$control_harness/basebin/gosu" "$case_dir/bin/gosu"
  write_fake_runtime "$case_dir/runner" "$runtime_version"
  write_fake_runtime "$case_dir/baseline" "2.337.0"
  : > "$case_dir/curl.log"
  : > "$case_dir/config.log"
  printf '0\n' > "$case_dir/listener-index"

  case "$registration_mode" in
    complete)
      printf 'registered\n' > "$case_dir/runner/.runner"
      printf 'credentials\n' > "$case_dir/runner/.credentials"
      printf 'rsa\n' > "$case_dir/runner/.credentials_rsaparams"
      ;;
    partial)
      printf 'registered\n' > "$case_dir/runner/.runner"
      ;;
    none) ;;
    *) fail "$case_name: unknown registration mode $registration_mode" ;;
  esac

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

  LISTENER_SEQUENCE="$sequence" \
    LISTENER_INDEX_FILE="$case_dir/listener-index" \
    RUN_READY="$case_dir/ready" \
    SIGNAL_FORWARDED="$case_dir/forwarded" \
    CHILD_FORWARDED="$case_dir/child-forwarded" \
    UPDATE_DONE="$case_dir/update-done" \
    UPDATE_DELAY_MS="$update_delay_ms" \
    CONFIG_MODE="$config_mode" \
    CONFIG_LOG="$case_dir/config.log" \
    CONFIG_READY="$case_dir/config-ready" \
    CONFIG_PID_FILE="$case_dir/config-pid" \
    CONFIG_STOPPED="$case_dir/config-stopped" \
    PATH="$case_dir/bin:$PATH" \
    RUNNER_HOME="$case_dir/runner" \
    RUNNER_BASELINE_HOME="$case_dir/baseline" \
    ACTIONS_RUNNER_BASELINE_VERSION=2.337.0 \
    GH_ADMIN_TOKEN=test-token \
    GITHUB_REPOSITORY=example/repo \
    CONTROL_RETRY_SECONDS="$retry_seconds" \
    CONTROL_SHORT_RETRY_SECONDS=0 \
    CONTROL_REPAIR_COOLDOWN_SECONDS=60 \
    CONTROL_UPDATE_WAIT_SECONDS=2 \
    CONTROL_UPDATE_SHUTDOWN_WAIT_SECONDS=2 \
    CONTROL_CHILD_STOP_WAIT_SECONDS=2 \
    bash "$repo_root/infra/github-runner-autoscaler/control-runner-entrypoint.sh" \
    >"$case_dir/stdout" 2>"$case_dir/stderr" &
  control_pid=$!
  CASE_DIR="$case_dir"
}

# Clean exit 0 is preserved.
start_control_case exit0 0 error
wait_control_exit exit0
grep -q 'listener exited cleanly' "$CASE_DIR/stderr" || fail 'exit0: clean listener exit not observed'

# Retryable exit 2 retries and can recover.
start_control_case retry2 2,0 error
wait_for_text "$CASE_DIR/stderr" 'listener requested retry' || fail 'retry2: retry path not observed'
wait_control_exit retry2

# Update exits 3 and 4 wait for update.finished, remove it, and relaunch.
for code in 3 4; do
  start_control_case "update$code" "$code,0" error
  wait_for_file "$CASE_DIR/update-done" || fail "update$code: fake update never completed"
  wait_control_exit "update$code"
  [[ ! -e "$CASE_DIR/runner/update.finished" ]] || fail "update$code: update.finished was not consumed"
  grep -q 'waiting for update completion' "$CASE_DIR/stderr" || fail "update$code: update wait not observed"
done

# Config-refresh exit 6 uses a bounded short delay instead of a hot loop.
start_control_case refresh6 6,0 error
wait_for_text "$CASE_DIR/stderr" 'configuration refreshed; retrying listener after short delay' || fail 'refresh6: delayed refresh path not observed'
wait_control_exit refresh6

# Unknown listener failures preserve registration and retry rather than re-register.
start_control_case unknown 97,0 healthy
wait_for_text "$CASE_DIR/stderr" 'unexpected status=97; preserving registration' || fail 'unknown: preserve path not observed'
wait_control_exit unknown
[[ ! -s "$CASE_DIR/curl.log" ]] || fail 'unknown listener failure must not call runner registration APIs'

# Exit 1 retries the same credentials once before any API-gated repair.
start_control_case api-error 1,1,wait error
wait_for_text "$CASE_DIR/stderr" 'retrying once with existing credentials before repair' || fail 'api-error: first credential retry not observed'
wait_for_text "$CASE_DIR/stderr" 'runners API is unavailable; preserving credentials' || fail 'api-error: non-destructive API failure not observed'
[[ -f "$CASE_DIR/runner/.runner" && -f "$CASE_DIR/runner/.credentials" ]] || fail 'API outage must preserve registration'
[[ "$(grep -c '/registration-token' "$CASE_DIR/curl.log" || true)" == 0 ]] || fail 'API outage must not mint a replacement registration'
stop_control_case api-error

# Exit 5 also retries existing credentials first. Only the repeated conflict
# can repair, and the repair marker is written before the destructive cleanup.
start_control_case bounded-repair 5,5,0 healthy
wait_for_text "$CASE_DIR/stderr" 'retrying once with existing credentials before repair' || fail 'bounded-repair: first same-credential retry missing'
wait_for_text "$CASE_DIR/stderr" 'scheduling bounded clean re-registration' || fail 'bounded-repair: repair path not observed'
wait_control_exit bounded-repair
[[ -f "$CASE_DIR/runner/.control-last-repair" ]] || fail 'bounded repair must persist cooldown marker'
[[ "$(grep -c '/registration-token' "$CASE_DIR/curl.log" || true)" == 1 ]] || fail 'bounded repair must mint exactly one replacement registration'

# A cooldown marker that predates a new entrypoint process blocks repair after
# the retry, proving cooldown state survives process/container restart.
start_control_case cooldown-restart 5,5,wait healthy
printf '%s\n' "$(date +%s)" > "$CASE_DIR/runner/.control-last-repair"
wait_for_text "$CASE_DIR/stderr" 'inside cooldown, preserving credentials' || fail 'cooldown-restart: persisted cooldown not honored'
[[ "$(grep -c '/registration-token' "$CASE_DIR/curl.log" || true)" == 0 ]] || fail 'persisted cooldown must block replacement registration'
stop_control_case cooldown-restart

# Deprecated-version exit 7 never re-registers; its long cooldown sleep remains
# interruptible, unlike the short retry cases.
start_control_case deprecated 7 healthy
wait_for_text "$CASE_DIR/stderr" 'runner version is deprecated' || fail 'deprecated: version warning not observed'
[[ ! -s "$CASE_DIR/curl.log" ]] || fail 'deprecated runner version must not call runners API'
stop_control_case deprecated

# Startup with only .runner is treated as half-written state, cleared, and
# re-registered before the listener starts.
start_control_case partial-start 0 healthy partial
wait_control_exit partial-start
grep -q 'incomplete control runner registration state' "$CASE_DIR/stderr" || fail 'partial-start: incomplete state not detected'
[[ "$(grep -c '/registration-token' "$CASE_DIR/curl.log" || true)" == 1 ]] || fail 'partial-start: expected exactly one registration token POST'
[[ -s "$CASE_DIR/runner/.runner" && -s "$CASE_DIR/runner/.credentials" ]] || fail 'partial-start: registration was not rebuilt'

# A failed first registration clears partial files before the retry sleep.
start_control_case failed-registration wait healthy none fail 2.337.0 5
wait_for_text "$CASE_DIR/stderr" 'registration failed status=9' || fail 'failed-registration: failure not observed'
[[ ! -e "$CASE_DIR/runner/.runner" && ! -e "$CASE_DIR/runner/.credentials" ]] || fail 'failed registration left partial local state'
stop_control_case failed-registration

# A runtime older than the image baseline is replaced from the external
# baseline without discarding persistent registration state.
start_control_case baseline-upgrade 0 error complete success 2.100.0
wait_control_exit baseline-upgrade
grep -q 'upgrading persisted runner runtime 2.100.0 -> baseline 2.337.0' "$CASE_DIR/stderr" || fail 'baseline-upgrade: persisted runtime was not upgraded'
[[ -s "$CASE_DIR/runner/.runner" && -s "$CASE_DIR/runner/.credentials" ]] || fail 'baseline-upgrade: registration state was lost'

# Normal Docker stop SIGINTs the full listener/worker process group and does
# not require GitHub API access.
start_control_case normal-stop wait error
wait_for_file "$CASE_DIR/ready" || fail 'normal-stop: listener never started'
kill -TERM "$control_pid"
wait_control_exit normal-stop
[[ -f "$CASE_DIR/forwarded" && -f "$CASE_DIR/child-forwarded" ]] || fail 'normal stop must signal listener and worker'
[[ -f "$CASE_DIR/runner/.runner" && -f "$CASE_DIR/runner/.credentials" ]] || fail 'normal stop must preserve registration'
[[ ! -s "$CASE_DIR/curl.log" ]] || fail 'normal stop must not need GitHub API'

# TERM during first registration stops/waits for the whole config process group,
# removes partial files, and never launches Runner.Listener.
start_control_case registration-stop wait healthy none wait
wait_for_file "$CASE_DIR/config-ready" || fail 'registration-stop: config process never became ready'
config_pid="$(cat "$CASE_DIR/config-pid")"
kill -TERM "$control_pid"
wait_control_exit registration-stop
[[ -f "$CASE_DIR/config-stopped" ]] || fail 'registration-stop: config process group did not receive SIGINT'
! kill -0 "$config_pid" 2>/dev/null || fail 'registration-stop: config child was orphaned'
[[ ! -e "$CASE_DIR/runner/.runner" && ! -e "$CASE_DIR/runner/.credentials" ]] || fail 'registration-stop: partial registration survived'
[[ "$(cat "$CASE_DIR/listener-index")" == 0 ]] || fail 'registration-stop: listener started after interrupted registration'

# TERM while wait_for_update is active waits for the in-flight update child
# instead of tearing the container down immediately.
start_control_case update-shutdown 3,wait error complete success 2.337.0 0 300
wait_for_text "$CASE_DIR/stderr" 'waiting for update completion' || fail 'update-shutdown: update wait not entered'
kill -TERM "$control_pid"
wait_control_exit update-shutdown
wait_for_file "$CASE_DIR/update-done" || fail 'update-shutdown: in-flight update was not allowed to finish'

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

#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RUNNER_NAME:=n150-control}"
: "${RUNNER_LABELS:=n150,control}"
: "${CONTROL_REPAIR_COOLDOWN_SECONDS:=300}"
: "${CONTROL_RETRY_SECONDS:=30}"

[[ "${CONTROL_REPAIR_COOLDOWN_SECONDS}" =~ ^[0-9]+$ ]] || {
  echo "CONTROL_REPAIR_COOLDOWN_SECONDS must be a non-negative integer" >&2
  exit 2
}
[[ "${CONTROL_RETRY_SECONDS}" =~ ^[0-9]+$ ]] || {
  echo "CONTROL_RETRY_SECONDS must be a non-negative integer" >&2
  exit 2
}

ADMIN_TOKEN="${GH_ADMIN_TOKEN}"
unset GH_ADMIN_TOKEN

RUNNER_HOME="${RUNNER_HOME:-/home/runner/actions-runner}"
API="https://api.github.com/repos/${GITHUB_REPOSITORY}"
REPAIR_MARKER=".control-last-repair"
AUTH=(
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2026-03-10"
)

auth_header() {
  printf 'header = "Authorization: Bearer %s"\n' "${ADMIN_TOKEN}"
}

registration_token() {
  curl -fsS --connect-timeout 5 --max-time 15 -K <(auth_header) -X POST "${AUTH[@]}" \
    "${API}/actions/runners/registration-token" | jq -er '.token'
}

runner_api_healthy() {
  local response
  response="$(curl -fsS --connect-timeout 5 --max-time 15 -K <(auth_header) "${AUTH[@]}" \
    "${API}/actions/runners?per_page=1")" || return 1
  jq -e '(.runners | type) == "array"' <<<"${response}" >/dev/null
}

clear_local_registration() {
  gosu runner rm -f .runner .credentials .credentials_rsaparams
}

configure_runner() {
  local token
  token="$(registration_token)"
  gosu runner ./config.sh \
    --url "https://github.com/${GITHUB_REPOSITORY}" \
    --token "${token}" \
    --name "${RUNNER_NAME}" \
    --labels "${RUNNER_LABELS}" \
    --work "_work" \
    --unattended \
    --replace
}

repair_allowed() {
  local now last
  [ ! -f "${REPAIR_MARKER}" ] && return 0
  now="$(date +%s)"
  last="$(cat "${REPAIR_MARKER}" 2>/dev/null || true)"
  [[ "${last}" =~ ^[0-9]+$ ]] || return 0
  (( now - last >= CONTROL_REPAIR_COOLDOWN_SECONDS ))
}

mark_repair() {
  local now
  now="$(date +%s)"
  printf '%s\n' "${now}" | gosu runner tee "${REPAIR_MARKER}" >/dev/null
}

wait_for_update() {
  local i
  for i in {0..30}; do
    if [ -f update.finished ]; then
      gosu runner rm -f update.finished
      return 0
    fi
    sleep 1
  done
  return 0
}

listener_pid=""
registration_pid=""

shutdown() {
  trap - TERM INT

  if [ -n "${registration_pid}" ]; then
    kill -INT -- "-${registration_pid}" 2>/dev/null || true
    wait "${registration_pid}" 2>/dev/null || true
    registration_pid=""
    # An interrupted config can leave partial local state. Remove it only after
    # the full registration process group has stopped; the next start uses
    # --replace to repair any server-side half-registration with the same name.
    clear_local_registration || true
  fi

  if [ -n "${listener_pid}" ]; then
    # Match the official run.sh manual-trap behavior: SIGINT the entire
    # Runner.Listener process group so an in-flight worker is cancelled too.
    kill -INT -- "-${listener_pid}" 2>/dev/null || true
    wait "${listener_pid}" 2>/dev/null || true
    listener_pid=""
  fi

  # Normal Docker/host stops preserve a completed persistent registration.
  exit 0
}
trap shutdown TERM INT

cd "${RUNNER_HOME}"

# Bash job control gives each background registration/listener job its own
# process group. The shutdown trap can therefore signal the whole tree instead
# of orphaning config.sh, Runner.Listener, or Runner.Worker.
set -m

while true; do
  if [ ! -f .runner ]; then
    configure_runner &
    registration_pid=$!
    registration_status=0
    wait "${registration_pid}" || registration_status=$?
    registration_pid=""

    if [ "${registration_status}" -ne 0 ]; then
      echo "warning: control runner registration failed status=${registration_status}; clearing partial local state" >&2
      clear_local_registration || true
      sleep "${CONTROL_RETRY_SECONDS}"
      continue
    fi
  fi

  # Run Runner.Listener directly rather than through run.sh/run-helper.sh.
  # The upstream wrapper intentionally maps listener exits 1, 5, and unknown
  # codes to 0; direct execution preserves the return code needed for bounded
  # credential/session recovery while keeping GitHub's self-update enabled.
  env -u GH_ADMIN_TOKEN gosu runner ./bin/Runner.Listener run &
  listener_pid=$!
  listener_status=0
  wait "${listener_pid}" || listener_status=$?
  listener_pid=""

  case "${listener_status}" in
    0)
      echo "control runner listener exited cleanly; stopping container" >&2
      exit 0
      ;;
    2)
      echo "control runner listener requested retry" >&2
      sleep 5
      ;;
    3|4)
      echo "control runner listener is updating; waiting for update completion" >&2
      wait_for_update
      ;;
    6)
      echo "control runner configuration refreshed; restarting listener" >&2
      ;;
    1|5)
      if ! runner_api_healthy; then
        echo "warning: listener failed status=${listener_status} but GitHub runners API is unavailable; preserving credentials" >&2
        sleep "${CONTROL_RETRY_SECONDS}"
        continue
      fi

      if ! repair_allowed; then
        echo "warning: listener failed status=${listener_status}; automatic re-registration is inside cooldown, preserving credentials" >&2
        sleep "${CONTROL_RETRY_SECONDS}"
        continue
      fi

      echo "warning: listener failed status=${listener_status}; scheduling one bounded clean re-registration" >&2
      mark_repair
      clear_local_registration
      ;;
    7)
      echo "error: GitHub runner version is deprecated; rebuild/deploy the control image with a supported runner version" >&2
      sleep "${CONTROL_REPAIR_COOLDOWN_SECONDS}"
      ;;
    *)
      echo "warning: control runner listener exited unexpected status=${listener_status}; preserving registration" >&2
      sleep "${CONTROL_RETRY_SECONDS}"
      ;;
  esac
done

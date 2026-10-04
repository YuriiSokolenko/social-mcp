#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RUNNER_NAME:=n150-control}"
: "${RUNNER_LABELS:=n150,control}"

ADMIN_TOKEN="${GH_ADMIN_TOKEN}"
unset GH_ADMIN_TOKEN

RUNNER_HOME="${RUNNER_HOME:-/home/runner/actions-runner}"
API="https://api.github.com/repos/${GITHUB_REPOSITORY}"
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

runner_pid=""
registration_pid=""
shutdown() {
  trap - TERM INT
  if [ -n "${registration_pid}" ]; then
    kill -TERM "${registration_pid}" 2>/dev/null || true
  fi
  if [ -n "${runner_pid}" ]; then
    # run.sh forwards this to Runner.Listener when RUNNER_MANUALLY_TRAP_SIG=1.
    kill -TERM "${runner_pid}" 2>/dev/null || true
    wait "${runner_pid}" 2>/dev/null || true
  fi
  # This is a persistent runner. Keep its GitHub registration and local
  # credentials across normal Docker/host restarts so control-plane capacity
  # can return without any GitHub API call.
  exit 0
}
trap shutdown TERM INT

cd "${RUNNER_HOME}"
if [ ! -f .runner ]; then
  # Run first-time registration asynchronously. Bash executes traps promptly
  # while waiting for a background job, so docker stop cannot get stuck behind
  # a foreground config.sh until the 30s grace period expires.
  configure_runner &
  registration_pid=$!
  registration_status=0
  wait "${registration_pid}" || registration_status=$?
  registration_pid=""
  [ "${registration_status}" -eq 0 ] || exit "${registration_status}"
fi

# The long-lived runner and every workflow job execute as the unprivileged
# runner user without the repository-admin token in their environment.
# Do not pass --disableupdate: GitHub's supported self-update path prevents
# a persistent control runner from aging out while the container stays alive.
# The official run.sh only forwards TERM/INT to Runner.Listener when this flag
# is set, so keep it enabled for graceful Docker stop/job cancellation.
env -u GH_ADMIN_TOKEN RUNNER_MANUALLY_TRAP_SIG=1 gosu runner ./run.sh &
runner_pid=$!

status=0
wait "${runner_pid}" || status=$?
runner_pid=""

# Any unexpected listener failure can mean the persisted credentials are no
# longer usable even when GitHub still has a runner with this name. Avoid a
# pagination/name-reconciliation decision entirely: if the runners API is
# healthy, clear local credentials so the next restart obtains a fresh token
# and config.sh --replace repairs either present or absent server state. If the
# API itself is unavailable or malformed, preserve the known local credentials
# and let Docker retry later.
if [ "${status}" -ne 0 ] && [ -f .runner ]; then
  if runner_api_healthy; then
    echo "warning: control runner listener failed status=${status}; forcing clean re-registration" >&2
    clear_local_registration
  else
    echo "warning: could not verify GitHub runners API; preserving local credentials" >&2
  fi
fi

exit "${status}"

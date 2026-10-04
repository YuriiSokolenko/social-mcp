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

runner_registration_state() {
  local response
  response="$(curl -fsS --connect-timeout 5 --max-time 15 -K <(auth_header) "${AUTH[@]}" \
    "${API}/actions/runners?per_page=100")" || return 1

  jq -er --arg name "${RUNNER_NAME}" '
    if (.runners | type) != "array" then error("missing runners")
    elif any(.runners[]; .name == $name) then "present"
    else "absent"
    end
  ' <<<"${response}"
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
shutdown() {
  trap - TERM INT
  if [ -n "${runner_pid}" ]; then
    kill -TERM "${runner_pid}" 2>/dev/null || true
    wait "${runner_pid}" 2>/dev/null || true
  fi
  # This is a persistent runner. Keep its GitHub registration and local
  # credentials across normal Docker/host restarts so control-plane capacity
  # can return without any GitHub API call.
  exit 0
}
# PID 1 must handle stop signals even while first-time registration is in progress.
trap shutdown TERM INT

cd "${RUNNER_HOME}"
if [ ! -f .runner ]; then
  configure_runner
fi

# The long-lived runner and every workflow job execute as the unprivileged
# runner user without the repository-admin token in their environment.
# Do not pass --disableupdate: GitHub's supported self-update path prevents
# a persistent control runner from aging out while the container stays alive.
env -u GH_ADMIN_TOKEN gosu runner ./run.sh &
runner_pid=$!

status=0
wait "${runner_pid}" || status=$?
runner_pid=""

# A listener failure may mean GitHub removed this registration. Reconcile only
# after the failure, never during a healthy restart. API failures are
# deliberately non-destructive: preserve the known local registration and let
# Docker retry later. Only a successful API response proving the runner absent
# permits local credentials to be cleared.
if [ "${status}" -ne 0 ] && [ -f .runner ]; then
  state=""
  if state="$(runner_registration_state)"; then
    if [ "${state}" = "absent" ]; then
      echo "warning: control runner registration is absent on GitHub; clearing stale local credentials" >&2
      clear_local_registration
    fi
  else
    echo "warning: could not reconcile control runner registration; preserving local credentials" >&2
  fi
fi

exit "${status}"

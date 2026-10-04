#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RUNNER_NAME:=n150-control}"
: "${RUNNER_LABELS:=n150,control}"

ADMIN_TOKEN="${GH_ADMIN_TOKEN}"
unset GH_ADMIN_TOKEN

RUNNER_HOME="/home/runner/actions-runner"
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

remove_token() {
  curl -fsS --connect-timeout 5 --max-time 15 -K <(auth_header) -X POST "${AUTH[@]}" \
    "${API}/actions/runners/remove-token" | jq -er '.token'
}

runner_registration_present() {
  curl -fsS --connect-timeout 5 --max-time 15 -K <(auth_header) "${AUTH[@]}" \
    "${API}/actions/runners?name=${RUNNER_NAME}&per_page=100" \
    | jq -e --arg name "${RUNNER_NAME}" '.runners | any(.[]; .name == $name)' >/dev/null
}

clear_local_registration() {
  rm -f .runner .credentials .credentials_rsaparams
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

remove_runner() {
  local token
  [ -f .runner ] || return 0
  token="$(remove_token)" || return 0
  gosu runner ./config.sh remove --token "${token}" >/dev/null 2>&1 || true
}

runner_pid=""
shutdown() {
  trap - TERM INT
  if [ -n "${runner_pid}" ]; then
    kill -TERM "${runner_pid}" 2>/dev/null || true
    wait "${runner_pid}" 2>/dev/null || true
  fi
  remove_runner
  exit 0
}
# PID 1 must handle stop signals even while registration is still in progress.
trap shutdown TERM INT

cd "${RUNNER_HOME}"

if [ -f .runner ]; then
  if ! runner_registration_present; then
    echo "warning: local control-runner registration is stale; registering again" >&2
    clear_local_registration
  fi
fi
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

# A failed listener can leave a server/local registration mismatch. Remove the
# registration best-effort so Docker's restart policy starts from a clean state.
if [ "${status}" -ne 0 ]; then
  echo "warning: control runner exited status=${status}; clearing registration for restart" >&2
  remove_runner
fi
exit "${status}"

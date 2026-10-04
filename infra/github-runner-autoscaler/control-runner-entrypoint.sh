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
    --replace \
    --disableupdate
}

remove_runner() {
  local token
  [ -f .runner ] || return 0
  token="$(remove_token)" || return 0
  gosu runner ./config.sh remove --token "${token}" >/dev/null 2>&1 || true
}

cd "${RUNNER_HOME}"
if [ ! -f .runner ]; then
  configure_runner
fi

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
trap shutdown TERM INT

# The long-lived runner and every workflow job execute as the unprivileged
# runner user without the repository-admin token in their environment.
env -u GH_ADMIN_TOKEN gosu runner ./run.sh &
runner_pid=$!

status=0
wait "${runner_pid}" || status=$?
exit "${status}"

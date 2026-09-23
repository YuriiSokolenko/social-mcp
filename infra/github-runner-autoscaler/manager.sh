#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

MAX_RUNNERS="${MAX_RUNNERS:-2}"
POLL_SECONDS="${POLL_SECONDS:-10}"
RUNNER_IMAGE="${RUNNER_IMAGE:-n150/github-pi-runner-ephemeral:0.87.1}"
RUNNER_PREFIX="${RUNNER_PREFIX:-n150-pi-eph}"
WORKFLOW_FILES="${WORKFLOW_FILES:-${WORKFLOW_FILE:-pi-issue-agent.yml,pi-pr-review.yml}}"
PI_CONFIG_DIR="${PI_CONFIG_DIR:-/host/pi-home/.pi/agent}"

API="https://api.github.com/repos/${GITHUB_REPOSITORY}"
AUTH=(
  -H "Authorization: Bearer ${GH_ADMIN_TOKEN}"
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2026-03-10"
)

log() {
  printf '[manager] %s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

api_get() {
  curl -fsS "${AUTH[@]}" "$1"
}

registration_token() {
  curl -fsS -X POST "${AUTH[@]}"     "${API}/actions/runners/registration-token" | jq -r '.token'
}

queued_jobs() {
  local total=0 workflow count
  IFS=',' read -ra workflows <<< "${WORKFLOW_FILES}"
  for workflow in "${workflows[@]}"; do
    workflow="$(printf '%s' "$workflow" | xargs)"
    [ -z "$workflow" ] && continue
    count="$(api_get "${API}/actions/workflows/${workflow}/runs?status=queued&per_page=100" | jq '.total_count')"
    total=$((total + count))
  done
  printf '%s\n' "$total"
}

busy_ephemeral_runners() {
  api_get "${API}/actions/runners?per_page=100"     | jq --arg prefix "${RUNNER_PREFIX}-"       '[.runners[] | select((.name | startswith($prefix)) and .busy == true)] | length'
}

cleanup_stale_registrations() {
  local ids
  ids="$(api_get "${API}/actions/runners?per_page=100"     | jq -r --arg prefix "${RUNNER_PREFIX}-"       '.runners[] | select((.name | startswith($prefix)) and .status == "offline") | .id')"

  if [ -z "$ids" ]; then
    return 0
  fi

  while read -r id; do
    [ -z "$id" ] && continue
    log "removing stale GitHub runner registration id=$id"
    curl -fsS -X DELETE "${AUTH[@]}" "${API}/actions/runners/${id}" >/dev/null || true
  done <<< "$ids"
}

active_containers() {
  docker ps     --filter 'label=social-mcp.pi-runner=ephemeral'     --format '{{.ID}}' | wc -l | tr -d ' '
}

spawn_runner() {
  local token name
  token="$(registration_token)"
  name="${RUNNER_PREFIX}-$(date +%s)-$RANDOM"

  log "starting ephemeral runner $name"

  docker run -d --rm     --name "$name"     --label social-mcp.pi-runner=ephemeral     --network host     -e "GITHUB_REPOSITORY=${GITHUB_REPOSITORY}"     -e "RUNNER_TOKEN=$token"     -e "RUNNER_NAME=$name"     -v "${PI_CONFIG_DIR}:/pi-config-ro:ro"     "${RUNNER_IMAGE}" >/dev/null
}

log "started repo=${GITHUB_REPOSITORY} max=${MAX_RUNNERS} poll=${POLL_SECONDS}s workflows=${WORKFLOW_FILES}"

while true; do
  cleanup_stale_registrations || log "warning: stale-runner cleanup failed"

  queued="$(queued_jobs || echo 0)"
  busy="$(busy_ephemeral_runners || echo 0)"
  active="$(active_containers || echo 0)"

  desired=$((queued + busy))
  if [ "$desired" -gt "$MAX_RUNNERS" ]; then
    desired="$MAX_RUNNERS"
  fi

  if [ "$active" -lt "$desired" ]; then
    to_start=$((desired - active))
    log "queued=$queued busy=$busy active=$active desired=$desired spawning=$to_start"
    for _ in $(seq 1 "$to_start"); do
      spawn_runner || log "warning: failed to start runner"
    done
  else
    log "queued=$queued busy=$busy active=$active desired=$desired"
  fi

  sleep "$POLL_SECONDS"
done

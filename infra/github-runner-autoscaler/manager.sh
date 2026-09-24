#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

MAX_RUNNERS="${MAX_RUNNERS:-2}"
POLL_SECONDS="${POLL_SECONDS:-10}"
RUNNER_IMAGE="${RUNNER_IMAGE:-n150/github-pi-runner-ephemeral:0.87.1}"
RUNNER_PREFIX="${RUNNER_PREFIX:-n150-pi-eph}"
WORKFLOW_FILES="${WORKFLOW_FILES:-${WORKFLOW_FILE:-pi-issue-agent.yml,pi-pr-review.yml,pi-dispatcher.yml}}"
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
    count="$(api_get "${API}/actions/workflows/${workflow}/runs?status=queued&per_page=100" | jq -er '.total_count | if type == "number" and . >= 0 and floor == . then . else error("invalid count") end')" || return 1
    if [[ ! "$count" =~ ^(0|[1-9][0-9]*)$ ]]; then
      log "warning: invalid queued run count for workflow=$workflow"
      return 1
    fi
    total=$((total + count))
  done
  printf '%s\n' "$total"
}

busy_ephemeral_runners() {
  api_get "${API}/actions/runners?per_page=100"     | jq --arg prefix "${RUNNER_PREFIX}-"       '[.runners[] | select((.name | startswith($prefix)) and .busy == true)] | length'
}

cleanup_stale_registrations() {
  local registrations containers id name
  # A runner can briefly be offline while its container is still starting.
  containers="$(docker ps -a --filter 'label=social-mcp.pi-runner=ephemeral' --format '{{.Names}}')" || return 1
  registrations="$(api_get "${API}/actions/runners?per_page=100" | jq -er --arg prefix "${RUNNER_PREFIX}-" \
    '.runners | if type != "array" then error("missing runners") else
      map(select((.name | type) == "string" and (.name | startswith($prefix)) and .status == "offline")) |
      map(select((.id | type) == "number") | [.id, .name] | @tsv) | join("\n")
    end')" || return 1

  if [ -z "$registrations" ]; then
    return 0
  fi

  while IFS=$'\t' read -r id name; do
    [[ "$id" =~ ^[0-9]+$ && "$name" == "${RUNNER_PREFIX}-"* ]] || continue
    if printf '%s\n' "$containers" | grep -Fxq -- "$name"; then
      continue
    fi
    log "removing stale GitHub runner registration id=$id"
    curl -fsS -X DELETE "${AUTH[@]}" "${API}/actions/runners/${id}" >/dev/null || true
  done <<< "$registrations"
}

active_containers() {
  local names
  names="$(docker ps --filter 'label=social-mcp.pi-runner=ephemeral' --format '{{.Names}}')" || return 1
  printf '%s\n' "$names" | awk -v prefix="${RUNNER_PREFIX}-" 'index($0, prefix) == 1 { count++ } END { print count+0 }'
}

spawn_runner() {
  local token name
  token="$(registration_token)"
  name="${RUNNER_PREFIX}-$(date +%s)-$RANDOM"

  log "starting ephemeral runner $name"

  docker run -d --rm     --name "$name"     --label social-mcp.pi-runner=ephemeral     --network host     -e "GITHUB_REPOSITORY=${GITHUB_REPOSITORY}"     -e "RUNNER_TOKEN=$token"     -e "RUNNER_NAME=$name"     -v "${PI_CONFIG_DIR}:/pi-config-ro:ro"     "${RUNNER_IMAGE}" >/dev/null
}

main() {
  log "started repo=${GITHUB_REPOSITORY} max=${MAX_RUNNERS} poll=${POLL_SECONDS}s workflows=${WORKFLOW_FILES}"
  while true; do
    cleanup_stale_registrations || log "warning: stale-runner cleanup failed"

    if ! queued="$(queued_jobs)" || ! busy="$(busy_ephemeral_runners)" || ! active="$(active_containers)"; then
      log "warning: runner state unavailable; skipping this poll"
      sleep "$POLL_SECONDS"
      continue
    fi
    if [[ ! "$busy" =~ ^(0|[1-9][0-9]*)$ || ! "$active" =~ ^(0|[1-9][0-9]*)$ ]]; then
      log "warning: invalid runner state; skipping this poll"
      sleep "$POLL_SECONDS"
      continue
    fi

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
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi

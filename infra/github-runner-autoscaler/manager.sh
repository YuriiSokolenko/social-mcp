#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

MAX_RUNNERS="${MAX_RUNNERS:-2}"
POLL_SECONDS="${POLL_SECONDS:-10}"
RUNNER_IMAGE="${RUNNER_IMAGE:-n150/github-pi-runner-ephemeral:0.87.1}"
RUNNER_PREFIX="${RUNNER_PREFIX:-n150-pi-eph}"
WORKFLOW_FILES="${WORKFLOW_FILES:-${WORKFLOW_FILE:-pi-issue-agent.yml,pi-pr-review.yml,pi-dispatcher.yml,pi-architect.yml}}"
PI_CONFIG_DIR="${PI_CONFIG_DIR:-/host/pi-home/.pi/agent}"
MODEL_STATUS_URL="${MODEL_STATUS_URL:-}"

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
  local total=0 workflow status count
  IFS=',' read -ra workflows <<< "${WORKFLOW_FILES}"
  for workflow in "${workflows[@]}"; do
    workflow="$(printf '%s' "$workflow" | xargs)"
    [ -z "$workflow" ] && continue
    for status in queued pending; do
      count="$(api_get "${API}/actions/workflows/${workflow}/runs?status=${status}&per_page=100" | jq -er '.total_count | if type == "number" and . >= 0 and floor == . then . else error("invalid count") end')" || return 1
      if [[ ! "$count" =~ ^(0|[1-9][0-9]*)$ ]]; then
        log "warning: invalid run count for workflow=$workflow status=$status"
        return 1
      fi
      total=$((total + count))
    done
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

retire_idle_runners() {
  local names containers name still_idle current_queue
  # An already registered idle runner can accept a job without consulting the
  # model gate. Remove surplus idle runners when no workflows are queued.
  names="$(api_get "${API}/actions/runners?per_page=100" | jq -er --arg prefix "${RUNNER_PREFIX}-" '
    .runners | if type != "array" then error("missing runners") else
      map(select((.name | type) == "string" and (.name | startswith($prefix))
        and .status == "online" and .busy == false)) | map(.name) | join("\n")
    end')" || return 1
  [ -n "$names" ] || return 0
  containers="$(docker ps --filter 'label=social-mcp.pi-runner=ephemeral' --format '{{.Names}}')" || return 1
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s\n' "$containers" | grep -Fxq -- "$name" || continue
    current_queue="$(queued_jobs)" || return 1
    [ "$current_queue" -eq 0 ] || return 0
    # Check once more immediately before stopping; never stop a known busy runner.
    still_idle="$(api_get "${API}/actions/runners?per_page=100" | jq -r --arg name "$name" '
      .runners | if type != "array" then error("missing runners") else
        any(.[]; .name == $name and .status == "online" and .busy == false)
      end')" || return 1
    [ "$still_idle" == true ] || continue
    log "stopping surplus idle runner $name"
    docker stop "$name" >/dev/null || return 1
  done <<< "$names"
}

model_start_capacity() {
  local active="$1" status waiting
  # A Pi job makes many model calls. Reserve runner slots for the entire job;
  # an idle inference slot does not imply an existing Pi job is finished.
  if [ -z "$MODEL_STATUS_URL" ]; then
    printf '%s\n' "$MAX_RUNNERS"
    return 0
  fi
  status="$(curl -fsS --max-time 5 "$MODEL_STATUS_URL")" || return 1
  case "$MODEL_STATUS_URL" in
    */slots|*/slots\?*)
      # Busy slots may belong to these jobs; use the larger reservation count.
      printf '%s\n' "$status" | jq -er --argjson active "$active" '
        if type != "array" or length == 0 or any(.[]; (.is_processing | type) != "boolean")
        then error("invalid llama.cpp slots")
        else ([.[] | select(.is_processing)] | length) as $busy
          | (length - (if $active > $busy then $active else $busy end))
          | if . > 0 then . else 0 end
        end
      '
      ;;
    *)
      waiting="$(printf '%s\n' "$status" | awk '
    /^vllm:num_requests_waiting(\{[^}]*\})?[[:space:]]/ {
      value = $NF
      if (value !~ /^[0-9]+(\.[0-9]+)?$/) exit 2
      total += value
      found = 1
    }
    END { if (!found) exit 2; print total + 0 }
      ')" || return 1
      if awk -v waiting="$waiting" 'BEGIN { exit !(waiting > 0) }'; then
        printf '0\n'
      else
        printf '%s\n' "$MAX_RUNNERS"
      fi
      ;;
  esac
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

    if [ "$queued" -eq 0 ] && [ "$active" -gt "$busy" ]; then
      retire_idle_runners || log "warning: idle-runner cleanup failed"
    fi

    desired=$((queued + busy))
    if [ "$desired" -gt "$MAX_RUNNERS" ]; then
      desired="$MAX_RUNNERS"
    fi

    if [ "$active" -lt "$desired" ]; then
      if ! available="$(model_start_capacity "$active")"; then
        log "warning: model status unavailable or invalid; delaying new runners"
        sleep "$POLL_SECONDS"
        continue
      fi
      to_start=$((desired - active))
      if [ "$to_start" -gt "$available" ]; then
        to_start="$available"
      fi
      if [ "$to_start" -eq 0 ]; then
        log "queued=$queued busy=$busy active=$active model_capacity=$available; delaying new runners"
        sleep "$POLL_SECONDS"
        continue
      fi
      log "queued=$queued busy=$busy active=$active desired=$desired model_capacity=$available spawning=$to_start"
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

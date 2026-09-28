#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

MAX_RUNNERS="${MAX_RUNNERS:-4}"
POLL_SECONDS="${POLL_SECONDS:-6}"
RUNNER_IMAGE="${RUNNER_IMAGE:-n150/github-pi-runner-ephemeral:0.87.1}"
RUNNER_PREFIX="${RUNNER_PREFIX:-n150-pi-eph}"
RUNNER_LABELS="${RUNNER_LABELS:-n150,pi-agent}"
WORKFLOW_FILES="${WORKFLOW_FILES:-${WORKFLOW_FILE:-pi-issue-agent.yml,pi-pr-review.yml,pi-pr-fix.yml,pi-dispatcher.yml,pi-architect.yml,pi-triage.yml}}"
PI_CONFIG_DIR="${PI_CONFIG_DIR:-/host/pi-home/.pi/agent}"
# Whether to seed the ephemeral worker with the Pi config (needed only by
# pool that actually runs the Pi/LLM agent) and whether to give it the host
# Docker socket (needed only by a pool whose jobs themselves run `docker`,
# e.g. the CI `docker` job's `docker compose up`). One manager instance runs
# per pool (see compose.yaml); these two flags are what tell an otherwise
# identical manager/worker pair apart.
MOUNT_PI_CONFIG="${MOUNT_PI_CONFIG:-true}"
MOUNT_DOCKER_SOCKET="${MOUNT_DOCKER_SOCKET:-false}"
MODEL_STATUS_URL="${MODEL_STATUS_URL:-}"
# This loop has no external supervisor for a hang (only `restart: unless-stopped`,
# which never fires for a process that is alive but stuck). Every network or
# Docker call below must be individually bounded, or one unresponsive request
# can freeze runner scaling for the whole host indefinitely.
CURL_CONNECT_TIMEOUT_SECONDS="${CURL_CONNECT_TIMEOUT_SECONDS:-5}"
CURL_MAX_TIME_SECONDS="${CURL_MAX_TIME_SECONDS:-15}"
DOCKER_TIMEOUT_SECONDS="${DOCKER_TIMEOUT_SECONDS:-30}"
CURL_TIMEOUT_OPTS=(--connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CURL_MAX_TIME_SECONDS")

API="https://api.github.com/repos/${GITHUB_REPOSITORY}"
AUTH=(
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2026-03-10"
)

# GH_ADMIN_TOKEN must never land in a curl argv -H flag: argv is visible to
# any local user on the host via `ps aux`/`/proc/<pid>/cmdline` for the call's
# duration. Feed it to curl as a config line via -K instead; every real curl
# call below passes it through process substitution so the token touches no
# argv and no file on disk.
auth_header() {
  printf 'header = "Authorization: Bearer %s"\n' "${GH_ADMIN_TOKEN}"
}

log() {
  printf '[manager] %s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

# Consecutive-idle-poll counts per runner name, for retire_idle_runners'
# debounce below. Lives for the process's lifetime (main's while loop), not
# per-call -- that's what makes "two consecutive polls" mean anything.
declare -A IDLE_STREAK=()

# Runs "$@" with a hard deadline. Uses a background job + watchdog instead of
# the external `timeout` binary so a test's shell-function override of the
# wrapped command (docker, curl, ...) still applies -- `timeout` would exec a
# fresh process and only see the real binary on PATH. Assumes "$@" is a single
# process that blocks in place (a stuck docker/curl call), not a wrapper that
# forks its own children: killing only $pid, not a process group, will not
# reliably reach grandchildren the wrapped command spawns.
# The watchdog closes its own stdout/stderr so it can never hold open the pipe
# a caller captures via $(...) -- otherwise, if it becomes an orphan (killed
# too late to matter, or killed but not yet reaped), the command substitution
# blocks until that orphan exits on its own, defeating the deadline entirely.
run_with_timeout() {
  local seconds="$1" pid watcher status
  shift
  "$@" &
  pid=$!
  ( exec >/dev/null 2>&1; sleep "$seconds"; kill -TERM "$pid" ) &
  watcher=$!
  if wait "$pid" 2>/dev/null; then status=0; else status=$?; fi
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$status"
}

api_get() {
  curl -fsS "${CURL_TIMEOUT_OPTS[@]}" -K <(auth_header) "${AUTH[@]}" "$1"
}

registration_token() {
  curl -fsS "${CURL_TIMEOUT_OPTS[@]}" -K <(auth_header) -X POST "${AUTH[@]}" "${API}/actions/runners/registration-token" | jq -r '.token'
}

queued_jobs() {
  # One repo-wide request per status instead of one per watched workflow file
  # (was 2*N GitHub API calls every poll -- with 6-7 watched files per pool
  # that alone was pushing close to the 5,000/hour token budget at
  # POLL_SECONDS=10, which is what let POLL_SECONDS come down safely).
  # total_count here is repo-wide (every workflow, not just ours), so we
  # filter workflow_runs by path ourselves rather than trusting it directly;
  # guard against a truncated page (unlikely for queued/pending, but silent
  # under-counting would be worse than skipping the poll).
  local total=0 status count
  for status in queued pending; do
    count="$(api_get "${API}/actions/runs?status=${status}&per_page=100" | jq -er --arg wf "${WORKFLOW_FILES}" '
      ($wf | split(",") | map(gsub("^\\s+|\\s+$"; ""))) as $watched
      | if (.workflow_runs | type) != "array" then error("missing workflow_runs")
        else
          (.total_count) as $total
          | (.workflow_runs | length) as $got
          | if ($total | type) != "number" or $total < 0 or ($total | floor) != $total or $total > $got
            then error("queued run list truncated or invalid total_count")
            else [.workflow_runs[] | select((.path // "" | split("/") | last) as $base | ($watched | index($base)) != null)] | length
            end
        end
    ')" || return 1
    if [[ ! "$count" =~ ^(0|[1-9][0-9]*)$ ]]; then
      log "warning: invalid queued-run count for status=$status"
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
  containers="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker ps -a --filter 'label=social-mcp.pi-runner=ephemeral' --format '{{.Names}}')" || return 1
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
    curl -fsS "${CURL_TIMEOUT_OPTS[@]}" -K <(auth_header) -X DELETE "${AUTH[@]}" "${API}/actions/runners/${id}" >/dev/null || true
  done <<< "$registrations"
}

active_containers() {
  local names
  names="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker ps --filter 'label=social-mcp.pi-runner=ephemeral' --format '{{.Names}}')" || return 1
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

  # A runner that isn't idle this poll (picked up a job, went offline, ...)
  # gets its streak dropped, so a later idle spell starts counting from zero
  # again rather than inheriting stale history.
  if [ "${#IDLE_STREAK[@]}" -gt 0 ]; then
    for name in "${!IDLE_STREAK[@]}"; do
      printf '%s\n' "$names" | grep -Fxq -- "$name" || unset 'IDLE_STREAK[$name]'
    done
  fi

  [ -n "$names" ] || return 0
  containers="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker ps --filter 'label=social-mcp.pi-runner=ephemeral' --format '{{.Names}}')" || return 1
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s\n' "$containers" | grep -Fxq -- "$name" || continue
    current_queue="$(queued_jobs)" || return 1
    [ "$current_queue" -eq 0 ] || return 0

    # Debounce: only retire a runner idle on two consecutive polls. A runner
    # can go online-and-idle for one snapshot right as GitHub is mid-assigning
    # it a job; requiring a second confirmation (a full POLL_SECONDS apart)
    # makes that race much less likely to catch a runner GitHub is about to
    # use, without meaningfully delaying retirement of a genuinely idle one.
    IDLE_STREAK["$name"]=$(( ${IDLE_STREAK["$name"]:-0} + 1 ))
    if [ "${IDLE_STREAK[$name]}" -lt 2 ]; then
      continue
    fi

    # Check once more immediately before stopping; never stop a known busy runner.
    still_idle="$(api_get "${API}/actions/runners?per_page=100" | jq -r --arg name "$name" '
      .runners | if type != "array" then error("missing runners") else
        any(.[]; .name == $name and .status == "online" and .busy == false)
      end')" || return 1
    [ "$still_idle" == true ] || continue
    log "stopping surplus idle runner $name"
    run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker stop "$name" >/dev/null || return 1
    unset 'IDLE_STREAK[$name]'
  done <<< "$names"
}

model_start_capacity() {
  local active="$1" status waiting
  # A Pi job makes many model calls. Reserve runner slots for the entire job;
  # an idle inference slot does not imply an existing Pi job is finished.
  if [ -z "$MODEL_STATUS_URL" ]; then
    printf 'unknown unknown %s\n' "$MAX_RUNNERS"
    return 0
  fi
  status="$(curl -fsS --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time 5 "$MODEL_STATUS_URL")" || return 1
  case "$MODEL_STATUS_URL" in
    */slots|*/slots\?*)
      # Busy slots may belong to these jobs; use the larger reservation count.
      printf '%s\n' "$status" | jq -er --argjson active "$active" '
        if type != "array" or length == 0 or any(.[]; (.is_processing | type) != "boolean")
        then error("invalid llama.cpp slots")
        else length as $total
          | ([.[] | select(.is_processing)] | length) as $busy
          | ($total - (if $active > $busy then $active else $busy end)) as $capacity
          | [$total, $busy, (if $capacity > 0 then $capacity else 0 end)] | @tsv
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
        printf 'unknown unknown 0\n'
      else
        printf 'unknown unknown %s\n' "$MAX_RUNNERS"
      fi
      ;;
  esac
}

spawn_runner() {
  local token name docker_args
  token="$(registration_token)"
  name="${RUNNER_PREFIX}-$(date +%s)-$RANDOM"

  docker_args=(
    -d --rm
    --name "$name"
    --label social-mcp.pi-runner=ephemeral
    --network host
    -e "GITHUB_REPOSITORY=${GITHUB_REPOSITORY}"
    -e "RUNNER_TOKEN=$token"
    -e "RUNNER_NAME=$name"
    -e "RUNNER_LABELS=${RUNNER_LABELS}"
  )
  if [ "$MOUNT_PI_CONFIG" == true ]; then
    docker_args+=(-v "${PI_CONFIG_DIR}:/pi-config-ro:ro")
  fi
  if [ "$MOUNT_DOCKER_SOCKET" == true ]; then
    docker_args+=(-v /var/run/docker.sock:/var/run/docker.sock)
  fi

  log "starting ephemeral runner $name (labels=${RUNNER_LABELS})"

  run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker run "${docker_args[@]}" "${RUNNER_IMAGE}" >/dev/null
}

main() {
  log "started repo=${GITHUB_REPOSITORY} max=${MAX_RUNNERS} poll=${POLL_SECONDS}s workflows=${WORKFLOW_FILES} labels=${RUNNER_LABELS}"
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

    if snapshot="$(model_start_capacity "$active")"; then
      read -r model_total model_busy available <<< "$snapshot"
    else
      model_total=unknown
      model_busy=unknown
      available=0
      log "warning: model status unavailable or invalid; delaying new runners"
    fi

    to_start=0
    if [ "$active" -lt "$desired" ]; then
      to_start=$((desired - active))
      if [ "$to_start" -gt "$available" ]; then
        to_start="$available"
      fi
    fi
    log "queued=$queued busy=$busy active=$active desired=$desired model_slots_total=$model_total model_slots_busy=$model_busy model_capacity=$available spawning=$to_start"
    if [ "$to_start" -gt 0 ]; then
      for _ in $(seq 1 "$to_start"); do
        spawn_runner || log "warning: failed to start runner"
      done
    fi

    sleep "$POLL_SECONDS"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi

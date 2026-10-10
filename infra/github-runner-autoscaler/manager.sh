#!/usr/bin/env bash
set -euo pipefail

: "${GH_ADMIN_TOKEN:?GH_ADMIN_TOKEN is required}"
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-YuriiSokolenko/social-mcp}"

MAX_RUNNERS="${MAX_RUNNERS:-8}"
MODEL_MAX_CONCURRENCY="${MODEL_MAX_CONCURRENCY:-8}"
POLL_SECONDS="${POLL_SECONDS:-6}"
RUNNER_IMAGE="${RUNNER_IMAGE:-n150/github-pi-runner-ephemeral:1.1.0-mini-swe-r5}"
RUN_CHECK_SANDBOX_IMAGE="${RUN_CHECK_SANDBOX_IMAGE:-n150/run-check-sandbox:0.1.4}"
RUN_CHECK_EXECUTOR_URL="${RUN_CHECK_EXECUTOR_URL:-http://127.0.0.1:17343}"
RUN_CHECK_EXECUTOR_PORT="${RUN_CHECK_EXECUTOR_PORT:-17343}"
RUN_CHECK_STAGE_VOLUME="${RUN_CHECK_STAGE_VOLUME:-social-mcp-run-check-stage}"
RUNNER_PREFIX="${RUNNER_PREFIX:-n150-pi-eph}"
RUNNER_LABELS="${RUNNER_LABELS:-n150,pi-agent}"
PI_ZOEKT_URL="${PI_ZOEKT_URL:-}"
PI_ZOEKT_REPOSITORY="${PI_ZOEKT_REPOSITORY:-YuriiSokolenko/social-mcp}"
PI_ZOEKT_TIMEOUT_MS="${PI_ZOEKT_TIMEOUT_MS:-3000}"
WORKFLOW_FILES="${WORKFLOW_FILES:-${WORKFLOW_FILE:-pi-issue-agent.yml,pi-pr-review.yml,pi-pr-fix.yml,pi-dispatcher.yml,pi-architect.yml,pi-triage.yml,verify-run-check-beelink.yml}}"
PI_CONFIG_DIR="${PI_CONFIG_DIR:-/host/pi-home/.pi/agent}"
# Whether to seed the ephemeral worker with the Pi config (needed only by
# pool that actually runs the Pi/LLM agent) and whether to give it the host
# Docker socket (needed only by a pool whose jobs themselves run `docker`,
# e.g. the CI `docker` job's `docker compose up`). One manager instance runs
# per pool (see compose.yaml); these two flags are what tell an otherwise
# identical manager/worker pair apart.
MOUNT_PI_CONFIG="${MOUNT_PI_CONFIG:-true}"
MOUNT_DOCKER_SOCKET="${MOUNT_DOCKER_SOCKET:-false}"
PIP_CACHE_HOST_DIR="${PIP_CACHE_HOST_DIR:-}"
RUN_CHECK_EXECUTOR_ENABLED="${RUN_CHECK_EXECUTOR_ENABLED:-${MOUNT_PI_CONFIG}}"
MODEL_STATUS_URL="${MODEL_STATUS_URL:-}"
# This loop has no external supervisor for a hang (only `restart: unless-stopped`,
# which never fires for a process that is alive but stuck). Every network or
# Docker call below must be individually bounded, or one unresponsive request
# can freeze runner scaling for the whole host indefinitely.
CURL_CONNECT_TIMEOUT_SECONDS="${CURL_CONNECT_TIMEOUT_SECONDS:-5}"
CURL_MAX_TIME_SECONDS="${CURL_MAX_TIME_SECONDS:-15}"
DOCKER_TIMEOUT_SECONDS="${DOCKER_TIMEOUT_SECONDS:-30}"
DOCKER_DEEP_PROBE_INTERVAL_SECONDS="${DOCKER_DEEP_PROBE_INTERVAL_SECONDS:-300}"
DOCKER_FORCED_DEEP_PROBE_MIN_INTERVAL_SECONDS=60
DOCKER_HEALTH_RETRY_SECONDS=5
[[ "$DOCKER_DEEP_PROBE_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "DOCKER_DEEP_PROBE_INTERVAL_SECONDS must be a positive integer" >&2
  exit 1
}
# Optional durable infra evidence (#437). Workers run with --rm and GitHub job
# logs can expire, so quarantine events and worker diagnostics go to a volume.
INFRA_EVIDENCE_DIR="${INFRA_EVIDENCE_DIR:-}"
INFRA_EVIDENCE_VOLUME="${INFRA_EVIDENCE_VOLUME:-}"
INFRA_EVIDENCE_MAX_EVENTS=500
CURL_TIMEOUT_OPTS=(--connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CURL_MAX_TIME_SECONDS")

if [ -n "$PIP_CACHE_HOST_DIR" ]; then
  [[ "$PIP_CACHE_HOST_DIR" == /* ]] || { echo "PIP_CACHE_HOST_DIR must be an absolute path" >&2; exit 1; }
  [[ "$PIP_CACHE_HOST_DIR" != *,* ]] || { echo "PIP_CACHE_HOST_DIR must not contain a comma" >&2; exit 1; }
  [ "$MOUNT_DOCKER_SOCKET" == true ] || { echo "PIP_CACHE_HOST_DIR is supported only for the general Docker-enabled pool" >&2; exit 1; }
fi

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
  local active="$1" status waiting busy metrics available
  if [[ ! "$MODEL_MAX_CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
    log "error: MODEL_MAX_CONCURRENCY must be a positive integer"
    return 1
  fi
  # A Pi job makes many model calls. Reserve runner slots for the entire job;
  # an idle inference slot does not imply an existing Pi job is finished.
  if [ -z "$MODEL_STATUS_URL" ]; then
    local available=$((MODEL_MAX_CONCURRENCY - active))
    [ "$available" -gt 0 ] || available=0
    printf '%s unknown %s\n' "$MODEL_MAX_CONCURRENCY" "$available"
    return 0
  fi
  # Exit 1: endpoint unreachable/HTTP error. Exit 2: response reached but invalid
  # or unrecognized. Either way the caller defers new runners (fail closed).
  # -s without -S: an unreachable endpoint is reported once by the caller, not by curl on every poll.
  status="$(curl -fs --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time 5 "$MODEL_STATUS_URL")" || return 1
  case "$MODEL_STATUS_URL" in
    */slots|*/slots\?*)
      # Busy slots may belong to these jobs; use the larger reservation count.
      printf '%s\n' "$status" | jq -er --argjson active "$active" --argjson model_limit "$MODEL_MAX_CONCURRENCY" '
        if type != "array" or length == 0 or any(.[]; (.is_processing | type) != "boolean")
        then error("invalid llama.cpp slots")
        else length as $runtime_total
          | ([.[] | select(.is_processing)] | length) as $runtime_busy
          | ([$runtime_total, $model_limit] | min) as $total
          | ([$runtime_busy, $total] | min) as $busy
          | ($total - (if $active > $busy then $active else $busy end)) as $capacity
          | [$total, $busy, (if $capacity > 0 then $capacity else 0 end)] | @tsv
        end
      ' || return 2
      ;;
    *)
      # Prometheus /metrics. vLLM exports vllm:num_requests_{running,waiting};
      # TensorFold exports the same gauges as tensorfold:num_requests_* ("a mirror
      # of tensorfold:requests_*"). Only the num_requests_* names are read, so the
      # tensorfold:requests_* duplicates are never double counted. TensorFold must
      # report both gauges; a partial sample is invalid. vLLM keeps its historical
      # rule (waiting is required, running defaults to 0).
      metrics="$(printf '%s\n' "$status" | awk '
    /^(vllm|tensorfold):num_requests_(running|waiting)(\{[^}]*\})?[[:space:]]/ {
      value = $NF
      if (value !~ /^[0-9]+(\.[0-9]+)?$/) exit 2
      split($1, name, ":")
      provider = name[1]
      providers[provider] = 1
      if ($1 ~ /num_requests_running/) { running += value; seen[provider, "running"] = 1 }
      else { total += value; seen[provider, "waiting"] = 1 }
    }
    END {
      count = 0
      for (p in providers) { count++; detected = p }
      if (count != 1 || !seen[detected, "waiting"]) exit 2
      if (detected == "tensorfold" && !seen[detected, "running"]) exit 2
      printf "%d %d %s\n", running, total, detected
    }
      ')" || return 2
      read -r busy waiting provider <<< "$metrics"
      if awk -v waiting="$waiting" 'BEGIN { exit !(waiting > 0) }'; then
        printf '%s %s 0 %s\n' "$MODEL_MAX_CONCURRENCY" "$busy" "$provider"
      else
        available=$((MODEL_MAX_CONCURRENCY - (active > busy ? active : busy)))
        [ "$available" -gt 0 ] || available=0
        printf '%s %s %s %s\n' "$MODEL_MAX_CONCURRENCY" "$busy" "$available" "$provider"
      fi
      ;;
  esac
}

# Set once the configured sandbox image and trusted executor have passed real checks.
RUN_CHECK_SANDBOX_VERIFIED=false
# Last model-status problem and detected provider; warnings are logged only on change.
MODEL_STATUS_PROBLEM=""
MODEL_STATUS_PROVIDER=""
verify_run_check_sandbox() {
  local image_id probe
  if [ "$RUN_CHECK_SANDBOX_VERIFIED" != true ]; then
    image_id="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker image inspect "$RUN_CHECK_SANDBOX_IMAGE" --format '{{.Id}}')" || {
      log "error: run_check sandbox image ${RUN_CHECK_SANDBOX_IMAGE} is missing; build and configure that explicit version before starting Pi runners"
      return 1
    }
    probe="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker run --rm --pull=never --network none --cap-drop ALL \
      --security-opt no-new-privileges --read-only --user 1001:1001 \
      --tmpfs /tmp:rw,nosuid,nodev,size=16m --entrypoint python3 "$RUN_CHECK_SANDBOX_IMAGE" \
      /usr/local/lib/run-check-sandbox-probe.py image 2>&1)" || {
        log "error: run_check sandbox image ${RUN_CHECK_SANDBOX_IMAGE} (${image_id}) failed its hardened container probe: ${probe}"
        return 1
    }
    RUN_CHECK_SANDBOX_IMAGE_ID="$image_id"
    RUN_CHECK_SANDBOX_PROBE="$probe"
    RUN_CHECK_SANDBOX_VERIFIED=true
    log "run_check sandbox image verified image=${RUN_CHECK_SANDBOX_IMAGE} image_id=${image_id} probe=${probe}"
  fi
  local attempts=0
  while [ "$attempts" -lt 10 ]; do
    if curl -fsS --max-time 2 "${RUN_CHECK_EXECUTOR_URL}/healthz" >/dev/null; then
      log "run_check backend ready image=${RUN_CHECK_SANDBOX_IMAGE} image_id=${RUN_CHECK_SANDBOX_IMAGE_ID:-unknown} executor=${RUN_CHECK_EXECUTOR_URL} probe=${RUN_CHECK_SANDBOX_PROBE:-cached}"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  log "error: trusted run_check executor ${RUN_CHECK_EXECUTOR_URL} is unavailable"
  return 1
}

# A fresh named volume is root:root 0755, but workers run as `runner`. Open it up
# before any worker starts, not lazily on the first event.
init_infra_evidence_dir() {
  [ -n "$INFRA_EVIDENCE_DIR" ] || return 0
  { mkdir -p "$INFRA_EVIDENCE_DIR" && chmod 1777 "$INFRA_EVIDENCE_DIR"; } 2>/dev/null \
    || log "warning: could not initialise infra evidence dir $INFRA_EVIDENCE_DIR"
}

record_infra_evidence() {
  local event="$1" detail="$2" file="${INFRA_EVIDENCE_DIR}/events.jsonl" containers=""
  [ -n "$INFRA_EVIDENCE_DIR" ] || return 0
  if [ "$event" == quarantined ]; then
    containers="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker ps -a --no-trunc --format '{{.ID}} {{.Names}} {{.Status}}' 2>&1 | head -n 40)" || true
  fi
  {
    init_infra_evidence_dir
    jq -nc --arg ts "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" --arg event "$event" --arg prefix "$RUNNER_PREFIX" \
      --arg detail "${detail:0:2000}" --arg containers "${containers:0:4000}" \
      '{ts: $ts, event: $event, pool: $prefix, detail: $detail, containers: $containers}' >> "$file"
    if [ "$(wc -l < "$file")" -gt "$INFRA_EVIDENCE_MAX_EVENTS" ]; then
      tail -n "$INFRA_EVIDENCE_MAX_EVENTS" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    fi
  } 2>/dev/null || log "warning: could not record infra evidence for $event"
}

# Quarantine is pool-wide: no registration tokens or containers while unhealthy.
# Never prune/restart a shared daemon automatically; that could kill busy jobs.
DOCKER_QUARANTINED=false
DOCKER_HEALTHY_POLLS=0
DOCKER_LAST_DEEP_PROBE_EPOCH=0
DOCKER_DEEP_PROBE_REQUIRED=true
DOCKER_FORCED_DEEP_PROBE_PENDING=false

docker_health_now() {
  date +%s
}

request_docker_deep_probe() {
  [ "$MOUNT_DOCKER_SOCKET" == true ] || return 0
  DOCKER_FORCED_DEEP_PROBE_PENDING=true
}

docker_deep_probe_due() {
  [ "$MOUNT_DOCKER_SOCKET" == true ] || return 1
  [ "$DOCKER_QUARANTINED" == true ] && return 0
  [ "$DOCKER_DEEP_PROBE_REQUIRED" == true ] && return 0

  local now elapsed
  now="$(docker_health_now)" || return 0
  [[ "$now" =~ ^[0-9]+$ ]] || return 0
  [ "$now" -ge "$DOCKER_LAST_DEEP_PROBE_EPOCH" ] || return 0
  elapsed=$((now - DOCKER_LAST_DEEP_PROBE_EPOCH))

  # Container-start failures are a useful corruption signal, but failures such
  # as a missing image or a busy daemon must not turn the expensive metadata
  # walk back into a per-poll hot loop. Quarantine bypasses this throttle above.
  if [ "$DOCKER_FORCED_DEEP_PROBE_PENDING" == true ] \
    && [ "$elapsed" -ge "$DOCKER_FORCED_DEEP_PROBE_MIN_INTERVAL_SECONDS" ]; then
    return 0
  fi

  [ "$elapsed" -ge "$DOCKER_DEEP_PROBE_INTERVAL_SECONDS" ]
}

run_docker_health_check() {
  local command="$1" output code attempts=0
  while true; do
    if [ "$command" == info ]; then
      if output="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker info 2>&1)"; then
        return 0
      fi
    else
      # Unlike `ps`, system df traverses rw snapshots and detects the #401 corruption.
      if output="$(run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker system df 2>&1)"; then
        return 0
      fi
    fi

    if [ "$attempts" -eq 0 ]; then
      attempts=1
      log "warning: Docker $command health check failed; retrying once in ${DOCKER_HEALTH_RETRY_SECONDS}s: $output"
      sleep "$DOCKER_HEALTH_RETRY_SECONDS"
      continue
    fi

    code=DOCKER_DAEMON_UNHEALTHY
    [[ "$output" != *'rw layer snapshot not found'* ]] || code=DOCKER_METADATA_CORRUPTION
    DOCKER_HEALTHY_POLLS=0
    if [ "$DOCKER_QUARANTINED" != true ]; then
      DOCKER_QUARANTINED=true
      record_infra_evidence quarantined "code=$code check=$command diagnostic=$output"
    fi
    log "infra_error code=$code general pool quarantined check=$command diagnostic=$output; inspect Docker/containerd journals and stale container IDs; repair host before retrying (no automatic prune/restart)"
    return 1
  done
}

run_docker_deep_probe() {
  run_docker_health_check metadata || return 1

  local now
  now="$(docker_health_now)" || now=
  if [[ "$now" =~ ^[0-9]+$ ]]; then
    DOCKER_LAST_DEEP_PROBE_EPOCH="$now"
    DOCKER_DEEP_PROBE_REQUIRED=false
    DOCKER_FORCED_DEEP_PROBE_PENDING=false
  else
    DOCKER_DEEP_PROBE_REQUIRED=true
  fi
  log "Docker metadata health probe healthy interval=${DOCKER_DEEP_PROBE_INTERVAL_SECONDS}s"
}

general_daemon_health() {
  [ "$MOUNT_DOCKER_SOCKET" == true ] || return 0

  # Keep the scheduler fast path cheap: daemon liveness is checked every poll,
  # while the storage/metadata walk is startup/cadence/failure/recovery only.
  run_docker_health_check info || return 1
  if docker_deep_probe_due; then
    run_docker_deep_probe || return 1
  fi

  if [ "$DOCKER_QUARANTINED" == true ]; then
    DOCKER_HEALTHY_POLLS=$((DOCKER_HEALTHY_POLLS + 1))
    [ "$DOCKER_HEALTHY_POLLS" -ge 2 ] || return 1
    DOCKER_QUARANTINED=false
    DOCKER_HEALTHY_POLLS=0
    log "general pool recovered after two healthy daemon polls"
    record_infra_evidence recovered "two healthy daemon polls"
  fi
}

quarantine_general_runners() {
  local names name id
  # GitHub refuses deletion of busy runners. Stop idle registrations accepting
  # unrelated jobs even if Docker cannot enumerate/stop their containers.
  names="$(api_get "${API}/actions/runners?per_page=100" | jq -er --arg prefix "${RUNNER_PREFIX}-" '
    .runners | if type != "array" then error("missing runners") else
      map(select((.name | startswith($prefix)) and .busy == false
        and any(.labels[]?; (.name | ascii_downcase) == "general"))) |
      map([.id, .name] | @tsv) | join("\n") end')" || return 1
  [ -n "$names" ] || return 0
  while IFS=$'\t' read -r id name; do
    [[ "$id" =~ ^[0-9]+$ && "$name" == "${RUNNER_PREFIX}-"* ]] || continue
    log "quarantine: removing idle general runner registration id=$id"
    curl -fsS "${CURL_TIMEOUT_OPTS[@]}" -K <(auth_header) -X DELETE "${AUTH[@]}" "${API}/actions/runners/${id}" >/dev/null || {
      log "warning: quarantine deletion refused for runner id=$id (possibly newly busy); continuing with remaining idle runners"
      continue
    }
  done <<< "$names"
}

spawn_runner() {
  local token name docker_args run_check_token
  general_daemon_health || return 1
  if [ "$MOUNT_PI_CONFIG" == true ]; then
    verify_run_check_sandbox || return 1
  fi
  token="$(registration_token)"
  name="${RUNNER_PREFIX}-$(date +%s)-$RANDOM"
  run_check_token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

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
  if [ "$MOUNT_PI_CONFIG" == true ] && [ "$RUN_CHECK_EXECUTOR_ENABLED" == true ]; then
    docker_args+=(
      -e "PI_RUN_CHECK_EXECUTOR_URL=${RUN_CHECK_EXECUTOR_URL}"
      -e "RUN_CHECK_EXECUTOR_TOKEN=${run_check_token}"
    )
  fi
  if [ "$MOUNT_PI_CONFIG" == true ] && [ -n "$PI_ZOEKT_URL" ]; then
    docker_args+=(
      -e "PI_ZOEKT_URL=${PI_ZOEKT_URL}"
      -e "PI_ZOEKT_REPOSITORY=${PI_ZOEKT_REPOSITORY}"
      -e "PI_ZOEKT_TIMEOUT_MS=${PI_ZOEKT_TIMEOUT_MS}"
    )
  fi
  if [ "$MOUNT_PI_CONFIG" == true ]; then
    docker_args+=(-v "${PI_CONFIG_DIR}:/pi-config-ro:ro")
  fi
  if [ "$MOUNT_DOCKER_SOCKET" == true ]; then
    docker_args+=(-v /var/run/docker.sock:/var/run/docker.sock)
    if [ -n "$INFRA_EVIDENCE_DIR" ] && [ -n "$INFRA_EVIDENCE_VOLUME" ]; then
      init_infra_evidence_dir
      docker_args+=(-v "${INFRA_EVIDENCE_VOLUME}:/evidence" -e INFRA_EVIDENCE_DIR=/evidence)
    fi
  fi
  if [ -n "$PIP_CACHE_HOST_DIR" ]; then
    docker_args+=(--mount "type=bind,source=${PIP_CACHE_HOST_DIR},target=/home/runner/.cache/pip")
  fi

  log "starting ephemeral runner $name (labels=${RUNNER_LABELS})"

  if ! run_with_timeout "$DOCKER_TIMEOUT_SECONDS" docker run "${docker_args[@]}" "${RUNNER_IMAGE}" >/dev/null; then
    # A failed container create/start can be the first visible symptom of
    # snapshot metadata corruption. Request an early deep validation, bounded
    # by the forced-probe minimum gap so unrelated persistent failures cannot
    # recreate a per-poll metadata hot loop. Pi runners never take this path.
    request_docker_deep_probe
    general_daemon_health || true
    return 1
  fi
}

main() {
  log "started repo=${GITHUB_REPOSITORY} max=${MAX_RUNNERS} poll=${POLL_SECONDS}s workflows=${WORKFLOW_FILES} labels=${RUNNER_LABELS}"
  init_infra_evidence_dir
  while true; do
    if ! general_daemon_health; then
      quarantine_general_runners || log "warning: unable to quarantine idle general registrations"
      sleep "$POLL_SECONDS"
      continue
    fi
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
      read -r model_total model_busy available model_provider <<< "$snapshot"
      model_provider="${model_provider:-llama.cpp-slots}"
      if [ -n "$MODEL_STATUS_PROBLEM" ]; then
        log "model status recovered (provider=$model_provider); new runners allowed again"
      elif [ "$model_provider" != "$MODEL_STATUS_PROVIDER" ]; then
        log "model status provider detected: $model_provider"
      fi
      MODEL_STATUS_PROBLEM=""
      MODEL_STATUS_PROVIDER="$model_provider"
    else
      case "$?" in
        1) problem="unreachable" ;;
        *) problem="invalid or unrecognized response" ;;
      esac
      model_total=unknown
      model_busy=unknown
      available=0
      # Log the cause once per state change; every poll still reports model_capacity=0 below.
      if [ "$problem" != "$MODEL_STATUS_PROBLEM" ]; then
        log "warning: model status $problem; delaying new runners until a valid sample"
        MODEL_STATUS_PROBLEM="$problem"
      fi
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
        spawn_runner || { log "warning: failed to start runner; stopping spawn batch"; break; }
      done
    fi

    sleep "$POLL_SECONDS"
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [ "$MOUNT_PI_CONFIG" == true ] && [ "$RUN_CHECK_EXECUTOR_ENABLED" == true ]; then
    env -i \
      PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" \
      RUN_CHECK_SANDBOX_IMAGE="$RUN_CHECK_SANDBOX_IMAGE" \
      RUN_CHECK_EXECUTOR_PORT="$RUN_CHECK_EXECUTOR_PORT" \
      RUN_CHECK_STAGE_VOLUME="$RUN_CHECK_STAGE_VOLUME" \
      RUN_CHECK_STAGE_ROOT=/run-check-stage \
      RUN_CHECK_RUNNER_PREFIX="$RUNNER_PREFIX" \
      RUN_CHECK_HARNESS_ROOT=/opt/social-mcp \
      node /usr/local/lib/run-check-executor.mjs &
    RUN_CHECK_EXECUTOR_PID=$!
    trap 'kill "$RUN_CHECK_EXECUTOR_PID" 2>/dev/null || true; wait "$RUN_CHECK_EXECUTOR_PID" 2>/dev/null || true' EXIT TERM INT
  fi
  main
fi

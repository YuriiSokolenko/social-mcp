#!/usr/bin/env bash
# Safely update and restart the documented social-mcp Beelink N150 stack.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
AUTOSCALER_REL="infra/github-runner-autoscaler"
ZOEKT_ROOT="${ZOEKT_ROOT:-/home/yurasik/zoekt-social-mcp}"
REPORT_DIR="${BEELINK_REPORT_DIR:-/var/log/beelink-update-restart}"
FORCE_BUSY=0 DRY_RUN=0 ASSUME_YES=0
ORIGINAL_USER="${SUDO_USER:-}"
STAGE="" REPORT="" PLAN=""
REPO_SLUG="YuriiSokolenko/social-mcp"

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/beelink-update-restart.sh [OPTIONS]

Update origin/dev in an isolated user-owned checkout, build required images,
then recreate the documented N150 runner and Zoekt services without deleting
volumes or rebooting the host.

Options:
  --dry-run      Inspect and print the plan; do not mutate Git, Docker, jobs,
                 Compose services, or configuration.
  --yes          Skip the final interactive confirmation.
  --force-busy   Explicitly permit interruption of active/queued Actions jobs
                 and busy self-hosted runners.
  --help         Show this help.

Run from a Beelink N150 with the repository checked out and its host
infra/github-runner-autoscaler/.env present. Reports are sanitized and stored
under /var/log/beelink-update-restart by default.
EOF
}
die() { printf 'ERROR: %s\n' "$*" >&2; log "ERROR: $*"; exit 1; }
log() { [[ -n "$REPORT" ]] && printf '%s %s\n' "$(date -Is)" "$*" >>"$REPORT" || true; }
run() {
  if (( DRY_RUN )); then printf '[dry-run]'; printf ' %q' "$@"; printf '\n'; return 0; fi
  "$@"
}
as_user() { runuser -u "$ORIGINAL_USER" -- "$@"; }
compose() { docker compose --project-directory "$STAGE" --env-file "$STAGE/$AUTOSCALER_REL/.env" --env-file "$STAGE/$AUTOSCALER_REL/latest-images.env" -f "$STAGE/$AUTOSCALER_REL/compose.yaml" "$@"; }
zoekt_compose() { docker compose --project-directory "$STAGE" -f "$STAGE/infra/zoekt/compose.yaml" "$@"; }

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1;;
    --yes) ASSUME_YES=1;;
    --force-busy) FORCE_BUSY=1;;
    --help|-h) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
  shift
done

mkdir -p "$REPORT_DIR" 2>/dev/null || { [[ -d "$REPORT_DIR" ]] || die "cannot create report directory: $REPORT_DIR"; }
REPORT="$REPORT_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
touch "$REPORT" 2>/dev/null || { REPORT=""; die "cannot write sanitized report under $REPORT_DIR"; }
chmod 0600 "$REPORT" 2>/dev/null || true
# shellcheck disable=SC2154 # rc is assigned by the EXIT trap itself.
trap 'rc=$?; log "finished exit=$rc"; if (( rc != 0 )); then printf "\nUpdate stopped (exit %s). Report: %s\n" "$rc" "${REPORT:-unavailable}" >&2; fi' EXIT

(( EUID == 0 )) || die 'run with sudo (root privileges are required)'
[[ -n "$ORIGINAL_USER" && "$ORIGINAL_USER" != root ]] || die 'SUDO_USER must identify the invoking non-root user'
id "$ORIGINAL_USER" >/dev/null 2>&1 || die 'SUDO_USER is not a valid account'
[[ -f "$REPO_DIR/.git" || -d "$REPO_DIR/.git" ]] || die "not inside a Git checkout: $REPO_DIR"
[[ -f "$REPO_DIR/$AUTOSCALER_REL/compose.yaml" && -f "$REPO_DIR/infra/zoekt/compose.yaml" ]] || die 'tracked N150 Compose manifests are missing'
[[ -f "$REPO_DIR/$AUTOSCALER_REL/.env" ]] || die "host configuration missing: $AUTOSCALER_REL/.env"

for cmd in docker git gh jq df runuser curl; do command -v "$cmd" >/dev/null 2>&1 || die "required command is missing: $cmd"; done
docker info >/dev/null 2>&1 || die 'Docker Engine is unavailable to root'
docker compose version >/dev/null 2>&1 || die 'Docker Compose plugin is unavailable'
as_user gh auth status >/dev/null 2>&1 || die 'GitHub CLI is not authenticated for the invoking account; authenticate gh and retry'
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}')" || die 'cannot identify Docker storage location'
for storage_path in "$REPO_DIR" "$DOCKER_ROOT"; do
  df -Pk "$storage_path" | awk 'NR==2 { if ($4 < 5242880) exit 1 }' || die "less than 5 GiB free on filesystem containing $storage_path"
done

HOST_FACTS="$(cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name /proc/cpuinfo 2>/dev/null || true)"
grep -Eiq 'Beelink' <<<"$HOST_FACTS" || die 'system vendor does not identify Beelink'
grep -Eiq 'N150' <<<"$HOST_FACTS" || die 'CPU or product identity does not identify N150'
unset HOST_FACTS

CURRENT_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)" || die 'cannot read current Git commit'
BRANCH="$(git -C "$REPO_DIR" branch --show-current)"
DIRTY="$(git -C "$REPO_DIR" status --porcelain --untracked-files=all | wc -l | tr -d ' ')"
REMOTE="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null)" || die 'origin remote is missing'
[[ "$REMOTE" == *'social-mcp.git' || "$REMOTE" == *'social-mcp' ]] || die 'origin does not identify the expected social-mcp repository'

DISK_IMAGES="$(docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' | awk '$1 ~ /^n150\// {print $0}' | wc -l | tr -d ' ')"
CONTAINERS="$(docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' | awk 'tolower($0) ~ /(pi-runner-manager|general-runner-manager|n150-control|social-mcp-zoekt|social-mcp\.pi-runner=ephemeral)/ {print $0}')"
[[ -n "$CONTAINERS" ]] || CONTAINERS='No named N150 services detected by repository service names.'

ACTIVE="$(as_user gh run list --repo "$REPO_SLUG" --limit 100 --json status --jq '[.[] | select(.status == "in_progress" or .status == "queued" or .status == "waiting" or .status == "requested")] | length' 2>/dev/null)" || die 'cannot query GitHub Actions active and queued jobs; refusing to restart blindly'
RUNNERS_JSON="$(as_user gh api "repos/$REPO_SLUG/actions/runners?per_page=100" 2>/dev/null)" || die 'cannot query GitHub self-hosted runner state; refusing to restart blindly'
BUSY="$(jq '[.runners[]? | select(.busy == true)] | length' <<<"$RUNNERS_JSON")"
QUEUED="$(as_user gh run list --repo "$REPO_SLUG" --limit 100 --json status --jq '[.[] | select(.status == "queued" or .status == "waiting" or .status == "requested")] | length' 2>/dev/null)" || die 'cannot query queued GitHub Actions jobs'
unset RUNNERS_JSON

PLAN="Repository $REPO_DIR ($BRANCH @ ${CURRENT_COMMIT:0:12}, dirty paths: $DIRTY); target origin/dev. Build manager, Pi worker, general worker, control runner, and run-check sandbox before stopping the documented managers, control runner, labeled ephemeral workers, and Zoekt. Keep all named volumes. Recreate only those tracked services; reindex Zoekt. Beszel is excluded because this repository has no tracked Beszel deployment."
printf 'Beelink N150 update plan\n%s\n\nCurrent named containers:\n%s\nDocker images in n150 namespace: %s\nGitHub active/queued runs: %s / %s busy self-hosted runners.\n' "$PLAN" "$CONTAINERS" "$DISK_IMAGES" "$ACTIVE" "$BUSY"
log "preflight current=$CURRENT_COMMIT branch=$BRANCH dirty_paths=$DIRTY n150_images=$DISK_IMAGES active_runs=$ACTIVE queued_runs=$QUEUED busy_runners=$BUSY"

if (( ! FORCE_BUSY )) && (( ACTIVE > 0 || BUSY > 0 )); then
  die "found active/queued Actions work ($ACTIVE active-or-queued runs; $BUSY busy runners); wait for drain or pass --force-busy"
fi
if (( FORCE_BUSY )) && (( ACTIVE > 0 || BUSY > 0 )); then
  printf '\nWARNING: --force-busy permits interruption of active/queued work and busy runners.\n'
fi
if (( DRY_RUN )); then
  printf '\nDry run complete. No Git, Docker, job, Compose, or configuration changes were made.\n'
  log 'dry-run plan complete; no mutating operations executed'
  exit 0
fi

if (( ! ASSUME_YES )); then
  printf '\nThis will interrupt/recreate the listed services. Persistent volumes are retained. Continue? [y/N] '
  IFS= read -r answer
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes || "$answer" == YES ]] || die 'cancelled by user'
fi

PARENT="$(dirname -- "$REPO_DIR")"
STAGE="$PARENT/.beelink-update-$(date -u +%Y%m%dT%H%M%SZ)-$$"
as_user mkdir -m 0700 "$STAGE" || die 'cannot create user-owned staging checkout'
STAGE="$(cd -- "$STAGE" && pwd -P)"
cleanup() { [[ -n "$STAGE" && -d "$STAGE" ]] && rm -rf -- "$STAGE" || true; }
trap 'rc=$?; if (( rc != 0 )); then log "rollback guidance: previous image tags and volumes remain; restore the prior checkout/config backup and run docker compose up -d --force-recreate from the previous revision"; fi; cleanup; log "finished exit=$rc"; if (( rc != 0 )); then printf "\nUpdate stopped (exit %s). Report: %s\n" "$rc" "${REPORT:-unavailable}" >&2; fi' EXIT
as_user git clone --single-branch --branch dev "$REMOTE" "$STAGE" >/dev/null 2>&1 || die 'could not clone origin/dev into isolated staging checkout'
[[ -d "$STAGE/.git" ]] || die 'staging checkout is invalid'
install -m 0600 -o "$ORIGINAL_USER" -g "$(id -gn "$ORIGINAL_USER")" "$REPO_DIR/$AUTOSCALER_REL/.env" "$STAGE/$AUTOSCALER_REL/.env" || die 'could not preserve host .env in staging checkout'
# Force only image tags to the values trusted by the fetched dev checkout.
# Host tokens, paths, and other local settings remain in the copied .env.
awk -F= '/^(PI_RUNNER_MANAGER_IMAGE|RUNNER_IMAGE|GENERAL_RUNNER_IMAGE|CONTROL_RUNNER_IMAGE|RUN_CHECK_SANDBOX_IMAGE)=/ {print}' \
  "$STAGE/$AUTOSCALER_REL/.env.example" >"$STAGE/$AUTOSCALER_REL/latest-images.env"
[[ -s "$STAGE/$AUTOSCALER_REL/latest-images.env" ]] || die 'tracked image versions are missing from .env.example'
chmod 0600 "$STAGE/$AUTOSCALER_REL/latest-images.env"
TARGET_COMMIT="$(git -C "$STAGE" rev-parse HEAD)"
BACKUP_DIR="/var/backups/beelink-update-restart"
install -d -m 0700 "$BACKUP_DIR"
cp -p "$REPO_DIR/$AUTOSCALER_REL/.env" "$BACKUP_DIR/autoscaler-env-$(date -u +%Y%m%dT%H%M%SZ).bak" || die 'could not back up autoscaler configuration'
log "staged target=$TARGET_COMMIT current_checkout_preserved=true env_backup=true"

compose config --quiet || die 'runner Compose configuration is invalid'
docker compose --project-directory "$STAGE" -f "$STAGE/infra/zoekt/compose.yaml" config --quiet || die 'Zoekt Compose configuration is invalid'
# Resolve only public image references from Compose's effective model. The
# complete config contains credentials, so it is captured and never printed.
COMPOSE_MODEL="$(compose config --format json)" || die 'could not resolve runner Compose configuration'
MANAGER_IMAGE="$(jq -r '.services["pi-runner-manager"].image' <<<"$COMPOSE_MODEL")"
PI_WORKER_IMAGE="$(jq -r '.services["pi-runner-manager"].environment.RUNNER_IMAGE' <<<"$COMPOSE_MODEL")"
GENERAL_WORKER_IMAGE="$(jq -r '.services["general-runner-manager"].environment.RUNNER_IMAGE' <<<"$COMPOSE_MODEL")"
CONTROL_IMAGE="$(jq -r '.services["control-runner"].image' <<<"$COMPOSE_MODEL")"
SANDBOX_IMAGE="$(jq -r '.services["pi-runner-manager"].environment.RUN_CHECK_SANDBOX_IMAGE' <<<"$COMPOSE_MODEL")"
unset COMPOSE_MODEL
for image in "$MANAGER_IMAGE" "$PI_WORKER_IMAGE" "$GENERAL_WORKER_IMAGE" "$CONTROL_IMAGE" "$SANDBOX_IMAGE"; do
  [[ "$image" == */*:* ]] || die 'resolved image reference is invalid'
done
docker build -f "$STAGE/$AUTOSCALER_REL/manager.Dockerfile" -t "$MANAGER_IMAGE" "$STAGE" || die 'manager image build failed; existing services were left running'
docker build -f "$STAGE/$AUTOSCALER_REL/worker.Dockerfile" -t "$PI_WORKER_IMAGE" "$STAGE" || die 'Pi worker image build failed; existing services were left running'
docker build -f "$STAGE/$AUTOSCALER_REL/worker-general.Dockerfile" -t "$GENERAL_WORKER_IMAGE" "$STAGE" || die 'general worker image build failed; existing services were left running'
docker build -f "$STAGE/$AUTOSCALER_REL/control-runner.Dockerfile" -t "$CONTROL_IMAGE" "$STAGE" || die 'control runner image build failed; existing services were left running'
docker build -f "$STAGE/$AUTOSCALER_REL/run-check-sandbox.Dockerfile" -t "$SANDBOX_IMAGE" "$STAGE" || die 'run-check sandbox image build failed; existing services were left running'

printf '\nWARNING: stopping N150 runner managers, control runner, ephemeral workers, and Zoekt. Volumes will be retained.\n'
compose stop control-runner general-runner-manager pi-runner-manager || die 'could not stop runner services cleanly'
EPHEMERAL="$(docker ps -q --filter label=social-mcp.pi-runner=ephemeral)"
if [[ -n "$EPHEMERAL" ]]; then
  # Label is assigned only by this repository's runner manager to ephemeral workers.
  readarray -t EPHEMERAL_IDS <<<"$EPHEMERAL"
  docker stop --time 30 "${EPHEMERAL_IDS[@]}" >/dev/null || die 'could not stop ephemeral runner containers'
fi
zoekt_compose stop zoekt-web >/dev/null 2>&1 || true
compose up -d --no-build --force-recreate control-runner general-runner-manager pi-runner-manager || die 'runner services failed to recreate'
zoekt_compose up -d --no-build --force-recreate zoekt-web || die 'Zoekt failed to recreate'

# Refresh the separate persistent Zoekt index; updater's own flock prevents overlap.
if [[ -x "$ZOEKT_ROOT/update-index.sh" ]]; then
  "$ZOEKT_ROOT/update-index.sh" || die 'Zoekt indexing failed; inspect its update.log'
else
  die "Zoekt updater missing at $ZOEKT_ROOT/update-index.sh"
fi

for service in pi-runner-manager general-runner-manager control-runner; do
  if [[ "$service" == control-runner ]]; then
    service_id="$(compose ps -q control-runner)"
  else
    service_id="$service"
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$service_id" 2>/dev/null || true)"
  [[ "$state" == running ]] || die "$service is not running after restart (state=${state:-missing})"
  log "service=$service state=$state image=$(docker inspect --format '{{.Image}}' "$service_id")"
done
zoekt_state="$(docker inspect --format '{{.State.Status}}' social-mcp-zoekt 2>/dev/null || true)"
[[ "$zoekt_state" == running ]] || die "Zoekt is not running (state=${zoekt_state:-missing})"
curl --fail --silent --show-error --max-time 10 -X POST -H 'Content-Type: application/json' -d '{"Q":"content:\"social-mcp\""}' http://127.0.0.1:6070/api/search >/dev/null || die 'Zoekt search check failed on 127.0.0.1:6070'

PI_MANAGER_RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' pi-runner-manager)"
GENERAL_MANAGER_RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' general-runner-manager)"
CONTROL_RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTROL_ID")"
[[ "$PI_MANAGER_RUNNING_IMAGE" == "$MANAGER_IMAGE" && "$GENERAL_MANAGER_RUNNING_IMAGE" == "$MANAGER_IMAGE" ]] || die 'runner manager image tags do not match the trusted dev configuration'
[[ "$CONTROL_RUNNING_IMAGE" == "$CONTROL_IMAGE" ]] || die 'control runner image tag does not match the trusted dev configuration'
for image in "$MANAGER_IMAGE" "$PI_WORKER_IMAGE" "$GENERAL_WORKER_IMAGE" "$CONTROL_IMAGE" "$SANDBOX_IMAGE"; do
  [[ -n "$image" ]] || die 'could not identify an expected configured image'
  image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
  [[ -n "$image_id" ]] || die "expected image is missing: $image"
  printf 'IMAGE %s %s\n' "$image" "$image_id"
  log "image=$image id=$image_id"
done
docker run --rm --entrypoint orbit "$PI_WORKER_IMAGE" version >/dev/null || die 'Orbit version probe failed'
docker run --rm --entrypoint mcp-searxng "$PI_WORKER_IMAGE" --help >/dev/null 2>&1 || log 'SearXNG MCP executable help probe unavailable; worker entrypoint performs initialize/search preflight before registration'
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:17343/healthz >/dev/null || die 'run-check executor health endpoint failed'
log 'verification managers_running=true control_runner_running=true zoekt_running=true orbit_probe=ok run_check_executor=ok; worker SearXNG MCP handshake/search occurs on ephemeral worker startup'

printf '\nUpdate/restart completed. Target dev commit: %s\nServices: pi-runner-manager, general-runner-manager, control-runner, social-mcp-zoekt\nRun-check executor: healthy; Orbit: verified.\n' "$TARGET_COMMIT"
printf 'Image IDs:\n'
docker image inspect --format '{{.RepoTags}} {{.Id}}' "$MANAGER_IMAGE" "$PI_WORKER_IMAGE" "$GENERAL_WORKER_IMAGE" "$CONTROL_IMAGE" "$SANDBOX_IMAGE"
printf 'Report: %s\n' "$REPORT"

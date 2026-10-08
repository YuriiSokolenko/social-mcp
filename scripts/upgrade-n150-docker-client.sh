#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly TARGET_HOSTNAME='n150'
readonly BACKUP_ROOT='/var/backups/n150-docker-client-upgrade'
readonly BUILDX_PACKAGE='docker-buildx-plugin'
readonly COMPOSE_PACKAGE='docker-compose-plugin'
readonly BUILDX_TARGET='0.37.1-1~ubuntu.26.04~resolute'
readonly COMPOSE_TARGET='5.6.0-1~ubuntu.26.04~resolute'
readonly BUILDX_PREVIOUS='0.34.1-1~ubuntu.26.04~resolute'
readonly COMPOSE_PREVIOUS='5.1.4-1~ubuntu.26.04~resolute'
readonly CLI_VERSION='29.8.2'
readonly CLI_URL='https://download.docker.com/linux/static/stable/x86_64/docker-29.8.2.tgz'
readonly CLI_SHA256='995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f'
readonly CLI_ROOT='/usr/local/lib/docker-cli/29.8.2'
readonly CLI_BINARY="$CLI_ROOT/docker"
readonly CLI_LINK='/usr/local/bin/docker'

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
package_version() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null; }
candidate_version() { apt-cache policy "$1" | awk '$1 == "Candidate:" { print $2; exit }'; }

printf '%s\n' \
  'N150 Docker client upgrade plan:' \
  '  - Install Docker CLI 29.8.2 from the official static archive after SHA-256 verification.' \
  '  - Upgrade only Buildx and Compose to their exact Ubuntu package versions.' \
  '  - Save previous/target packages, checksums, and rollback instructions under /var/backups.' \
  '  - Do not upgrade Docker Engine, restart the daemon, stop containers, or remove images/volumes.'

[[ "$(hostname -s)" == "$TARGET_HOSTNAME" ]] || die "must run on host $TARGET_HOSTNAME"
[[ "$EUID" -eq 0 ]] || die 'run with sudo or as root'
[[ -r /etc/os-release ]] || die '/etc/os-release is unavailable'
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 26.04 ]] || die 'expected Ubuntu 26.04'
[[ "$(dpkg --print-architecture)" == amd64 ]] || die 'expected amd64 packages'
[[ -d /var/backups && ! -L /var/backups && "$(realpath /var/backups)" == /var/backups ]] || die 'unexpected /var/backups path'
[[ ! -L "$BACKUP_ROOT" ]] || die "$BACKUP_ROOT must not be a symlink"
[[ ! -e "$BACKUP_ROOT" || -d "$BACKUP_ROOT" ]] || die "$BACKUP_ROOT is not a directory"
command -v apt-get >/dev/null || die 'apt-get is required'
command -v docker >/dev/null || die 'Docker CLI is required'
docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable'

current_buildx="$(package_version "$BUILDX_PACKAGE")"
current_compose="$(package_version "$COMPOSE_PACKAGE")"
current_cli="$(docker --version)"
if [[ "$current_buildx" == "$BUILDX_TARGET" && "$current_compose" == "$COMPOSE_TARGET" \
  && "$current_cli" == 'Docker version 29.8.2,'* && "$(readlink -f "$CLI_LINK" 2>/dev/null || true)" == "$CLI_BINARY" ]]; then
  [[ "$(docker buildx version)" == *'v0.37.1'* ]] || die 'Buildx executable version verification failed'
  [[ "$(docker compose version --short)" == '5.6.0' ]] || die 'Compose executable version verification failed'
  printf 'Already at target versions: CLI %s, Buildx %s, Compose %s\n' "$CLI_VERSION" "$current_buildx" "$current_compose"
  exit 0
fi
[[ "$current_buildx" == "$BUILDX_PREVIOUS" || "$current_buildx" == "$BUILDX_TARGET" ]] || die "unexpected Buildx package version: $current_buildx"
[[ "$current_compose" == "$COMPOSE_PREVIOUS" || "$current_compose" == "$COMPOSE_TARGET" ]] || die "unexpected Compose package version: $current_compose"
[[ "$current_cli" == 'Docker version 29.5.3,'* || "$current_cli" == 'Docker version 29.8.2,'* ]] || die "unexpected effective Docker CLI: $current_cli"
[[ ! -e "$CLI_LINK" && ! -L "$CLI_LINK" ]] || [[ "$(readlink -f "$CLI_LINK" 2>/dev/null || true)" == "$CLI_BINARY" ]] || die "$CLI_LINK already exists; inspect it before continuing"
[[ ! -e "$CLI_ROOT" || -x "$CLI_BINARY" ]] || die "$CLI_ROOT exists without its expected binary"
if [[ -e "$CLI_ROOT" ]]; then
  [[ "$("$CLI_BINARY" --version)" == 'Docker version 29.8.2,'* ]] || die "$CLI_BINARY exists with an unexpected version"
fi

apt-get update
[[ "$(candidate_version "$BUILDX_PACKAGE")" == "$BUILDX_TARGET" ]] || die "$BUILDX_PACKAGE target is not the current apt candidate"
[[ "$(candidate_version "$COMPOSE_PACKAGE")" == "$COMPOSE_TARGET" ]] || die "$COMPOSE_PACKAGE target is not the current apt candidate"

plugin_args=("$BUILDX_PACKAGE=$BUILDX_TARGET" "$COMPOSE_PACKAGE=$COMPOSE_TARGET")
plan="$(apt-get -s --no-install-recommends --only-upgrade install "${plugin_args[@]}")"
changed="$(printf '%s\n' "$plan" | awk '$1 == "Inst" { print $2 }' | sort -u)"
unexpected="$(printf '%s\n' "$changed" | while IFS= read -r package; do
  [[ -z "$package" || "$package" == "$BUILDX_PACKAGE" || "$package" == "$COMPOSE_PACKAGE" ]] || printf '%s\n' "$package"
done)"
[[ -z "$unexpected" ]] || die "apt would change unexpected packages: $unexpected"
removals="$(printf '%s\n' "$plan" | awk '$1 == "Remv" { print $2 }')"
[[ -z "$removals" ]] || die "apt would remove packages: $removals"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$BACKUP_ROOT/$timestamp"
[[ ! -e "$backup_dir" && ! -L "$backup_dir" ]] || die "backup path already exists: $backup_dir"
install -d -m 0700 "$BACKUP_ROOT" "$backup_dir/installed" "$backup_dir/target"
printf 'captured_at_utc=%s\n' "$timestamp" > "$backup_dir/versions.txt"
printf 'docker-ce-cli package %s\n' "$(package_version docker-ce-cli)" >> "$backup_dir/versions.txt"
printf 'effective Docker CLI %s\n' "$current_cli" >> "$backup_dir/versions.txt"
printf '%s %s\n' "$BUILDX_PACKAGE" "$current_buildx" >> "$backup_dir/versions.txt"
printf '%s %s\n' "$COMPOSE_PACKAGE" "$current_compose" >> "$backup_dir/versions.txt"
printf 'target Docker CLI %s\n' "$CLI_VERSION" >> "$backup_dir/versions.txt"
printf 'target %s %s\n' "$BUILDX_PACKAGE" "$BUILDX_TARGET" >> "$backup_dir/versions.txt"
printf 'target %s %s\n' "$COMPOSE_PACKAGE" "$COMPOSE_TARGET" >> "$backup_dir/versions.txt"

server_version_before="$(docker version --format '{{.Server.Version}}')"
docker ps --no-trunc --format '{{.ID}}' | sort > "$backup_dir/container-ids.before"
for package in "$BUILDX_PACKAGE" "$COMPOSE_PACKAGE"; do
  case "$package" in
    "$BUILDX_PACKAGE") old="$current_buildx"; target="$BUILDX_TARGET" ;;
    "$COMPOSE_PACKAGE") old="$current_compose"; target="$COMPOSE_TARGET" ;;
  esac
  (cd "$backup_dir/installed" && apt-get download "$package=$old")
  (cd "$backup_dir/target" && apt-get download "$package=$target")
done

curl -fsSL "$CLI_URL" -o "$backup_dir/target/docker-$CLI_VERSION.tgz"
printf '%s  %s\n' "$CLI_SHA256" "$backup_dir/target/docker-$CLI_VERSION.tgz" | sha256sum --check -
(
  cd "$backup_dir"
  find installed target -type f \( -name '*.deb' -o -name '*.tgz' \) -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check SHA256SUMS
)

mapfile -t buildx_old < <(find "$backup_dir/installed" -maxdepth 1 -type f -name "${BUILDX_PACKAGE}_*.deb" -print)
mapfile -t compose_old < <(find "$backup_dir/installed" -maxdepth 1 -type f -name "${COMPOSE_PACKAGE}_*.deb" -print)
[[ "${#buildx_old[@]}" -eq 1 && "${#compose_old[@]}" -eq 1 ]] || die 'rollback plugin archives are incomplete'
{
  printf '#!/usr/bin/env bash\nset -Eeuo pipefail\n'
  printf 'dpkg -i --force-downgrade %q %q\n' "${buildx_old[0]}" "${compose_old[0]}"
  printf 'if [[ "$(readlink -f %q 2>/dev/null || true)" == %q ]]; then rm -f %q; fi\n' "$CLI_LINK" "$CLI_BINARY" "$CLI_LINK"
  printf 'rm -f %q\nrmdir %q\ndocker info >/dev/null\n' "$CLI_BINARY" "$CLI_ROOT"
} > "$backup_dir/rollback.sh"
chmod 0700 "$backup_dir/rollback.sh"

apt-get install -y --no-install-recommends --only-upgrade "${plugin_args[@]}"
install -d -m 0755 /usr/local/lib/docker-cli "$CLI_ROOT"
if [[ ! -x "$CLI_BINARY" ]]; then
  mkdir -p "$backup_dir/target/cli"
  tar -xzf "$backup_dir/target/docker-$CLI_VERSION.tgz" -C "$backup_dir/target/cli" docker/docker
  install -m 0755 "$backup_dir/target/cli/docker/docker" "$CLI_BINARY"
fi
ln -s "$CLI_BINARY" "$CLI_LINK"
hash -r

[[ "$(docker --version)" == 'Docker version 29.8.2,'* ]] || die 'Docker CLI version verification failed'
[[ "$(package_version "$BUILDX_PACKAGE")" == "$BUILDX_TARGET" ]] || die 'Buildx package version verification failed'
[[ "$(package_version "$COMPOSE_PACKAGE")" == "$COMPOSE_TARGET" ]] || die 'Compose package version verification failed'
[[ "$(docker buildx version)" == *'v0.37.1'* ]] || die 'Buildx executable version verification failed'
[[ "$(docker compose version --short)" == '5.6.0' ]] || die 'Compose executable version verification failed'
[[ "$(docker version --format '{{.Server.Version}}')" == "$server_version_before" ]] || die 'Docker Engine version changed unexpectedly'
docker ps --no-trunc --format '{{.ID}}' | sort > "$backup_dir/container-ids.after"
cmp -s "$backup_dir/container-ids.before" "$backup_dir/container-ids.after" || die 'running container set changed unexpectedly'
docker info >/dev/null

printf 'Docker client upgrade verified. Backup: %s\n' "$backup_dir"
printf 'Rollback command: sudo bash %s/rollback.sh\n' "$backup_dir"
docker --version
docker buildx version
docker compose version --short

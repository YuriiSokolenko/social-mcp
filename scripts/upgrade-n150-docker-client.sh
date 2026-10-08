#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

readonly TARGET_HOSTNAME='n150'
readonly BACKUP_ROOT='/var/backups/n150-docker-client-upgrade'
readonly BUILDX_PACKAGE='docker-buildx-plugin'
readonly COMPOSE_PACKAGE='docker-compose-plugin'
readonly BUILDX_TARGET='0.38.0-1~ubuntu.26.04~resolute'
readonly COMPOSE_TARGET='5.6.0-1~ubuntu.26.04~resolute'
readonly BUILDX_PREVIOUS='0.34.1-1~ubuntu.26.04~resolute'
readonly COMPOSE_PREVIOUS='5.1.4-1~ubuntu.26.04~resolute'
readonly CLI_VERSION='29.8.2'
readonly CLI_URL='https://download.docker.com/linux/static/stable/x86_64/docker-29.8.2.tgz'
readonly CLI_SHA256='995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f'
readonly CLI_ROOT='/usr/local/lib/docker-cli/29.8.2'
readonly CLI_BINARY="$CLI_ROOT/docker"
readonly CLI_LINK='/usr/local/bin/docker'

MODIFIED=0
ROLLING_BACK=0
BACKUP_DIR=''

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
package_version() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null; }
version_hash() {
  apt-cache show "$1=$2" | awk '
    /^SHA256: / && !found { checksum = $2; found = 1 }
    END { if (found) print checksum }
  '
}
sha256_file() { sha256sum -- "$1" | awk '{ print $1 }'; }
secure_root_directory() {
  local path="$1" mode
  [[ -d "$path" && ! -L "$path" && "$(realpath -e -- "$path")" == "$path" ]] || return 1
  [[ "$(stat -c '%u' -- "$path")" == 0 ]] || return 1
  mode="$(stat -c '%a' -- "$path")"
  (( (8#$mode & 0022) == 0 ))
}

verify_installed_versions() {
  [[ "$(docker --version)" == 'Docker version 29.8.2,'* ]] || return 1
  [[ "$(package_version "$BUILDX_PACKAGE")" == "$BUILDX_TARGET" ]] || return 1
  [[ "$(package_version "$COMPOSE_PACKAGE")" == "$COMPOSE_TARGET" ]] || return 1
  [[ "$(docker buildx version)" == *'v0.38.0'* ]] || return 1
  [[ "$(docker compose version --short)" == '5.6.0' ]] || return 1
  [[ "$(readlink -f -- "$CLI_LINK")" == "$CLI_BINARY" ]] || return 1
  [[ "$(command -v docker)" == "$CLI_LINK" ]] || return 1
  docker info >/dev/null 2>&1 || return 1
}

rollback() {
  local dir="$1" rc=0 previous_link previous_link_text recorded_cli effective_cli recorded_command
  local -a buildx_deb compose_deb
  [[ "$EUID" -eq 0 ]] || { printf 'Rollback requires root. Backups retained at %s\n' "$dir" >&2; return 1; }
  if ! { [[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] && secure_root_directory "$BACKUP_ROOT" \
    && [[ "$dir" == "$BACKUP_ROOT/"* && "${dir#"$BACKUP_ROOT/"}" != */* ]] \
    && [[ -d "$dir" && ! -L "$dir" && "$(realpath -e -- "$dir")" == "$dir" ]] \
    && secure_root_directory "$dir"; }; then
    printf 'Invalid backup directory; backups retained: %s\n' "$dir" >&2; return 1;
  fi
  [[ -f "$dir/manifest" && ! -L "$dir/manifest" && -f "$dir/SHA256SUMS" && ! -L "$dir/SHA256SUMS" ]] || {
    printf 'Rollback metadata missing; backups retained: %s\n' "$dir" >&2; return 1;
  }
  (cd "$dir" && sha256sum --check --status SHA256SUMS) || {
    printf 'Rollback artifact checksum verification failed; backups retained: %s\n' "$dir" >&2; return 1;
  }
  # shellcheck disable=SC1090,SC1091
  source "$dir/manifest"
  previous_link="$PREVIOUS_LINK_PRESENT"
  previous_link_text="$PREVIOUS_LINK_TEXT"
  recorded_cli="$PREVIOUS_CLI_VERSION"
  effective_cli="$PREVIOUS_CLI_EFFECTIVE"
  recorded_command="$PREVIOUS_COMMAND"
  mapfile -t buildx_deb < <(find "$dir/installed" -maxdepth 1 -type f -name "${BUILDX_PACKAGE}_*.deb" -print)
  mapfile -t compose_deb < <(find "$dir/installed" -maxdepth 1 -type f -name "${COMPOSE_PACKAGE}_*.deb" -print)
  [[ "${#buildx_deb[@]}" -eq 1 && "${#compose_deb[@]}" -eq 1 ]] || {
    printf 'Rollback packages are incomplete; backups retained: %s\n' "$dir" >&2; return 1;
  }

  ROLLING_BACK=1
  dpkg -i --force-downgrade "${buildx_deb[0]}" "${compose_deb[0]}" || rc=$?
  if [[ -L "$CLI_LINK" ]] && [[ "$(readlink -- "$CLI_LINK")" == "$CLI_BINARY" ]]; then
    rm -- "$CLI_LINK" || rc=$?
  elif [[ "$previous_link" == yes && -L "$CLI_LINK" ]] && [[ "$(readlink -- "$CLI_LINK")" == "$previous_link_text" ]]; then
    : # The pre-upgrade link is already restored; leave it in place.
  elif [[ -e "$CLI_LINK" || -L "$CLI_LINK" ]]; then
    printf 'Refusing to replace unexpected path during rollback: %s\n' "$CLI_LINK" >&2
    rc=1
  fi
  if [[ "$previous_link" == yes && ! -e "$CLI_LINK" && ! -L "$CLI_LINK" ]]; then
    ln -s -- "$previous_link_text" "$CLI_LINK" || rc=$?
  fi
  hash -r
  if [[ "$CLI_BINARY_PREEXISTING" == no && -e "$CLI_BINARY" && ! -L "$CLI_BINARY" ]] \
    && [[ "$(sha256_file "$CLI_BINARY")" == "$CLI_NEW_BINARY_SHA256" ]]; then
    rm -- "$CLI_BINARY" || rc=$?
    rmdir -- "$CLI_ROOT" 2>/dev/null || true
  fi

  if [[ "$rc" -eq 0 ]]; then
    [[ "$(package_version "$BUILDX_PACKAGE")" == "$PREVIOUS_BUILDX" ]] || rc=1
    [[ "$(package_version "$COMPOSE_PACKAGE")" == "$PREVIOUS_COMPOSE" ]] || rc=1
    [[ "$(docker --version)" == "$recorded_cli" ]] || rc=1
    [[ "$(command -v docker)" == "$recorded_command" ]] || rc=1
    [[ "$(readlink -f -- "$(command -v docker)" 2>/dev/null || true)" == "$effective_cli" ]] || rc=1
    [[ "$(docker buildx version)" == *"$PREVIOUS_BUILDX_EXECUTABLE_VERSION"* ]] || rc=1
    [[ "$(docker compose version --short)" == "$PREVIOUS_COMPOSE_EXECUTABLE_VERSION" ]] || rc=1
    [[ "$(docker version --format '{{.Server.Version}}')" == "$SERVER_VERSION" ]] || rc=1
    docker info >/dev/null 2>&1 || rc=1
  fi
  if [[ "$rc" -ne 0 ]]; then
    printf 'ROLLBACK FAILED (status %s). Backups preserved at %s\n' "$rc" "$dir" >&2
    return 1
  fi
  printf 'Rollback verified: CLI %s, Buildx %s, Compose %s. Backups retained at %s\n' \
    "$recorded_cli" "$PREVIOUS_BUILDX" "$PREVIOUS_COMPOSE" "$dir"
}

on_error() {
  local rc=$? failed_command="$BASH_COMMAND" rollback_rc=0
  trap - ERR
  if [[ "$MODIFIED" -eq 1 && "$ROLLING_BACK" -eq 0 ]]; then
    printf 'Upgrade failed (status %s): %s\n' "$rc" "$failed_command" >&2
    rollback "$BACKUP_DIR" || rollback_rc=$?
    if [[ "$rollback_rc" -eq 0 ]]; then
      printf 'Automatic rollback verified successfully. Backups: %s\n' "$BACKUP_DIR" >&2
    else
      printf 'Automatic rollback FAILED (status %s). Backups retained: %s\n' "$rollback_rc" "$BACKUP_DIR" >&2
    fi
  else
    printf 'ERROR (status %s): %s\n' "$rc" "$failed_command" >&2
  fi
  exit "$rc"
}
trap on_error ERR

if [[ "${1:-}" == '--rollback' ]]; then
  [[ "$#" -eq 2 ]] || die 'usage: script --rollback BACKUP_DIRECTORY'
  rollback "$2"
  exit $?
elif [[ "$#" -ne 0 ]]; then
  die 'unexpected arguments'
fi

printf '%s\n' \
  'N150 Docker client upgrade plan:' \
  '  - Install Docker CLI 29.8.2 from the official static archive after SHA-256 verification.' \
  '  - Upgrade only Buildx and Compose to their exact Ubuntu package versions.' \
  '  - Save verified packages, checksums, and rollback metadata under /var/backups.' \
  '  - Do not upgrade Docker Engine, restart the daemon, stop containers, or remove images/volumes.'

[[ "$(hostname -s)" == "$TARGET_HOSTNAME" ]] || die "must run on host $TARGET_HOSTNAME"
[[ "$EUID" -eq 0 ]] || die 'run with sudo or as root'
[[ -r /etc/os-release ]] || die '/etc/os-release is unavailable'
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 26.04 ]] || die 'expected Ubuntu 26.04'
[[ "$(dpkg --print-architecture)" == amd64 ]] || die 'expected amd64 packages'
[[ -d /var/backups && ! -L /var/backups && "$(realpath -e /var/backups)" == /var/backups ]] || die 'unexpected /var/backups path'
[[ ! -L "$BACKUP_ROOT" ]] || die "$BACKUP_ROOT must not be a symlink"
[[ ! -e "$BACKUP_ROOT" || -d "$BACKUP_ROOT" ]] || die "$BACKUP_ROOT is not a directory"
if [[ -e "$BACKUP_ROOT" ]]; then
  [[ "$(stat -c '%u:%a' -- "$BACKUP_ROOT")" == '0:700' ]] || die "$BACKUP_ROOT must be owned by root with mode 0700"
fi
command -v apt-get >/dev/null || die 'apt-get is required'
command -v apt-cache >/dev/null || die 'apt-cache is required'
command -v dpkg >/dev/null || die 'dpkg is required'
command -v docker >/dev/null || die 'Docker CLI is required'

PATH_DOCKER="$(command -v docker)"
[[ "$PATH_DOCKER" == /* && -x "$PATH_DOCKER" ]] || die "invalid Docker command path: $PATH_DOCKER"
PREVIOUS_CLI_EFFECTIVE="$(readlink -f -- "$PATH_DOCKER")"
[[ -n "$PREVIOUS_CLI_EFFECTIVE" && -f "$PREVIOUS_CLI_EFFECTIVE" && -x "$PREVIOUS_CLI_EFFECTIVE" ]] || die 'Docker executable resolution failed'
PREVIOUS_CLI_VERSION="$("$PATH_DOCKER" --version)"
[[ "$PREVIOUS_CLI_VERSION" == 'Docker version 29.5.3,'* || "$PREVIOUS_CLI_VERSION" == 'Docker version 29.8.2,'* ]] || die "unexpected effective Docker CLI: $PREVIOUS_CLI_VERSION"
[[ "$PATH_DOCKER" == "$CLI_LINK" || "$PATH_DOCKER" == /usr/bin/docker ]] || die "ambiguous Docker command path: $PATH_DOCKER"
docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable'

PREVIOUS_LINK_PRESENT=no
PREVIOUS_LINK_TEXT=''
if [[ -L "$CLI_LINK" ]]; then
  PREVIOUS_LINK_PRESENT=yes
  PREVIOUS_LINK_TEXT="$(readlink -- "$CLI_LINK")"
  [[ "$(readlink -f -- "$CLI_LINK")" == "$PREVIOUS_CLI_EFFECTIVE" ]] || die "unexpected existing Docker symlink: $CLI_LINK"
elif [[ -e "$CLI_LINK" ]]; then
  die "$CLI_LINK is a non-symlink file; refusing to replace it"
fi
for path in /usr/local /usr/local/bin /usr/local/lib; do
  secure_root_directory "$path" || die "unexpected, writable, or non-root target directory: $path"
done
if [[ -e /usr/local/lib/docker-cli ]]; then secure_root_directory /usr/local/lib/docker-cli || die 'unsafe /usr/local/lib/docker-cli directory'; fi
if [[ -e "$CLI_ROOT" ]]; then secure_root_directory "$CLI_ROOT" || die "unsafe CLI directory: $CLI_ROOT"; fi
if [[ -e "$CLI_BINARY" ]]; then
  [[ ! -L "$CLI_BINARY" && -x "$CLI_BINARY" && "$("$CLI_BINARY" --version)" == 'Docker version 29.8.2,'* ]] || die "unexpected existing CLI path: $CLI_BINARY"
  [[ "$(stat -c '%u' -- "$CLI_BINARY")" == 0 ]] || die "$CLI_BINARY is not owned by root"
  [[ $(( 8#$(stat -c '%a' -- "$CLI_BINARY") & 0022 )) -eq 0 ]] || die "$CLI_BINARY is writable by non-root users"
  CLI_BINARY_PREEXISTING=yes
else
  CLI_BINARY_PREEXISTING=no
fi

current_buildx="$(package_version "$BUILDX_PACKAGE")"
current_compose="$(package_version "$COMPOSE_PACKAGE")"
[[ "$current_buildx" == "$BUILDX_PREVIOUS" || "$current_buildx" == "$BUILDX_TARGET" ]] || die "unexpected Buildx package version: $current_buildx"
[[ "$current_compose" == "$COMPOSE_PREVIOUS" || "$current_compose" == "$COMPOSE_TARGET" ]] || die "unexpected Compose package version: $current_compose"
server_version_before="$(docker version --format '{{.Server.Version}}')"
[[ -n "$server_version_before" ]] || die 'Docker Engine version is unavailable'

# Recover an interrupted previous run before making a new backup or package plan.
if [[ -d "$BACKUP_ROOT" ]]; then
  while IFS= read -r -d '' stale_dir; do
    [[ -d "$stale_dir" && ! -L "$stale_dir" ]] || die "unsafe backup entry: $stale_dir"
    if [[ -e "$stale_dir/MODIFICATION_STARTED" && ! -e "$stale_dir/COMPLETED" && ! -e "$stale_dir/RECOVERED" ]]; then
      printf 'Recovering interrupted upgrade from %s\n' "$stale_dir"
      rollback "$stale_dir" || die "could not recover interrupted backup: $stale_dir"
      : > "$stale_dir/RECOVERED"
      chmod 0600 "$stale_dir/RECOVERED"
      current_buildx="$(package_version "$BUILDX_PACKAGE")"
      current_compose="$(package_version "$COMPOSE_PACKAGE")"
      PATH_DOCKER="$(command -v docker)"
      PREVIOUS_CLI_EFFECTIVE="$(readlink -f -- "$PATH_DOCKER")"
      PREVIOUS_CLI_VERSION="$("$PATH_DOCKER" --version)"
      PREVIOUS_LINK_PRESENT=no
      PREVIOUS_LINK_TEXT=''
      if [[ -L "$CLI_LINK" ]]; then
        PREVIOUS_LINK_PRESENT=yes
        PREVIOUS_LINK_TEXT="$(readlink -- "$CLI_LINK")"
      fi
      if [[ -e "$CLI_BINARY" ]]; then CLI_BINARY_PREEXISTING=yes; else CLI_BINARY_PREEXISTING=no; fi
    fi
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print0)
fi

if [[ "$current_buildx" == "$BUILDX_TARGET" && "$current_compose" == "$COMPOSE_TARGET" \
  && "$PREVIOUS_CLI_VERSION" == 'Docker version 29.8.2,'* && "$PATH_DOCKER" == "$CLI_LINK" ]]; then
  verify_installed_versions || die 'installed target versions or daemon health could not be verified'
  printf 'Already at target versions; no changes made.\n'
  exit 0
fi

apt-get update
for spec in "$BUILDX_PACKAGE:$BUILDX_TARGET" "$COMPOSE_PACKAGE:$COMPOSE_TARGET" \
  "$BUILDX_PACKAGE:$current_buildx" "$COMPOSE_PACKAGE:$current_compose"; do
  package="${spec%%:*}" version="${spec#*:}"
  package_sha256="$(version_hash "$package" "$version")"
  [[ "$package_sha256" =~ ^[[:xdigit:]]{64}$ ]] || die "exact package version or SHA-256 metadata unavailable for $package=$version"
done

plugin_args=("$BUILDX_PACKAGE=$BUILDX_TARGET" "$COMPOSE_PACKAGE=$COMPOSE_TARGET")
plan="$(apt-get -s --no-install-recommends --only-upgrade install "${plugin_args[@]}")"
changed="$(printf '%s\n' "$plan" | awk '$1 == "Inst" { print $2 }' | sort -u)"
unexpected="$(printf '%s\n' "$changed" | while IFS= read -r package; do
  [[ -z "$package" || "$package" == "$BUILDX_PACKAGE" || "$package" == "$COMPOSE_PACKAGE" ]] || printf '%s\n' "$package"
done)"
[[ -z "$unexpected" ]] || die "apt would change unexpected packages: $unexpected"
removals="$(printf '%s\n' "$plan" | awk '$1 == "Remv" { print $2 }')"
[[ -z "$removals" ]] || die "apt would remove packages: $removals"

timestamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
BACKUP_DIR="$BACKUP_ROOT/$timestamp"
[[ ! -e "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || die "backup path already exists: $BACKUP_DIR"
install -d -o root -g root -m 0700 "$BACKUP_ROOT" "$BACKUP_DIR/installed" "$BACKUP_DIR/target"
cat > "$BACKUP_DIR/manifest" <<EOF
PREVIOUS_BUILDX=$(printf '%q' "$current_buildx")
PREVIOUS_COMPOSE=$(printf '%q' "$current_compose")
PREVIOUS_BUILDX_EXECUTABLE_VERSION=$(printf '%q' "$(docker buildx version | sed -E 's/.*(v[0-9.]+).*/\1/')")
PREVIOUS_COMPOSE_EXECUTABLE_VERSION=$(printf '%q' "$(docker compose version --short)")
PREVIOUS_CLI_VERSION=$(printf '%q' "$PREVIOUS_CLI_VERSION")
PREVIOUS_CLI_EFFECTIVE=$(printf '%q' "$PREVIOUS_CLI_EFFECTIVE")
PREVIOUS_COMMAND=$(printf '%q' "$PATH_DOCKER")
PREVIOUS_LINK_PRESENT=$(printf '%q' "$PREVIOUS_LINK_PRESENT")
PREVIOUS_LINK_TEXT=$(printf '%q' "$PREVIOUS_LINK_TEXT")
CLI_BINARY_PREEXISTING=$(printf '%q' "$CLI_BINARY_PREEXISTING")
SERVER_VERSION=$(printf '%q' "$server_version_before")
EOF
chmod 0600 "$BACKUP_DIR/manifest"
printf 'original_command=%s\noriginal_effective=%s\noriginal_link=%s\n' \
  "$PATH_DOCKER" "$PREVIOUS_CLI_EFFECTIVE" "$PREVIOUS_LINK_TEXT" > "$BACKUP_DIR/executable-resolution.txt"
printf 'engine_version=%s\n' "$server_version_before" > "$BACKUP_DIR/engine.txt"
docker ps --no-trunc --format '{{.ID}}' | sort > "$BACKUP_DIR/container-ids.before"

download_package() {
  local package="$1" version="$2" directory="$3" expected actual file
  local -a files
  expected="$(version_hash "$package" "$version")"
  (cd "$directory" && apt-get download "$package=$version")
  mapfile -t files < <(find "$directory" -maxdepth 1 -type f -name "${package}_*.deb" -print)
  [[ "${#files[@]}" -eq 1 ]] || die "could not identify exactly one archive for $package=$version"
  file="${files[0]}"
  actual="$(sha256_file "$file")"
  [[ "$actual" == "$expected" ]] || die "checksum mismatch for $package=$version"
}
download_package "$BUILDX_PACKAGE" "$current_buildx" "$BACKUP_DIR/installed"
download_package "$COMPOSE_PACKAGE" "$current_compose" "$BACKUP_DIR/installed"
download_package "$BUILDX_PACKAGE" "$BUILDX_TARGET" "$BACKUP_DIR/target"
download_package "$COMPOSE_PACKAGE" "$COMPOSE_TARGET" "$BACKUP_DIR/target"
curl -fsSL "$CLI_URL" -o "$BACKUP_DIR/target/docker-$CLI_VERSION.tgz"
printf '%s  %s\n' "$CLI_SHA256" "$BACKUP_DIR/target/docker-$CLI_VERSION.tgz" | sha256sum --check -
tar -tzf "$BACKUP_DIR/target/docker-$CLI_VERSION.tgz" | awk '$0 == "docker/docker" { found=1 } END { exit !found }' || die 'CLI archive has no expected docker binary'
(
  cd "$BACKUP_DIR"
  find installed target -type f \( -name '*.deb' -o -name '*.tgz' \) -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  chmod 0600 SHA256SUMS
  sha256sum --check SHA256SUMS
)

tar -xzf "$BACKUP_DIR/target/docker-$CLI_VERSION.tgz" -C "$BACKUP_DIR/target" docker/docker
CLI_NEW_BINARY_SHA256="$(sha256_file "$BACKUP_DIR/target/docker/docker")"
printf 'CLI_NEW_BINARY_SHA256=%q\n' "$CLI_NEW_BINARY_SHA256" >> "$BACKUP_DIR/manifest"
(
  cd "$BACKUP_DIR"
  find installed target -type f \( -name '*.deb' -o -name '*.tgz' \) -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  chmod 0600 SHA256SUMS
  sha256sum --check SHA256SUMS
)

# Set the recovery guard before the first mutation outside the protected backup directory.
MODIFIED=1
: > "$BACKUP_DIR/MODIFICATION_STARTED"
chmod 0600 "$BACKUP_DIR/MODIFICATION_STARTED"
apt-get install -y --no-install-recommends --only-upgrade "${plugin_args[@]}"
install -d -o root -g root -m 0755 /usr/local/lib/docker-cli "$CLI_ROOT"
if [[ ! -e "$CLI_BINARY" ]]; then
  install -o root -g root -m 0755 "$BACKUP_DIR/target/docker/docker" "$CLI_BINARY"
fi
CLI_NEW_BINARY_SHA256="$(sha256_file "$CLI_BINARY")"
[[ "$CLI_NEW_BINARY_SHA256" == "$(sha256_file "$BACKUP_DIR/target/docker/docker")" ]]
if [[ "$PREVIOUS_LINK_PRESENT" == yes ]]; then
  [[ -L "$CLI_LINK" && "$(readlink -- "$CLI_LINK")" == "$PREVIOUS_LINK_TEXT" ]]
  rm -- "$CLI_LINK"
fi
ln -s -- "$CLI_BINARY" "$CLI_LINK"
hash -r
verify_installed_versions
[[ "$(docker version --format '{{.Server.Version}}')" == "$server_version_before" ]]
docker ps --no-trunc --format '{{.ID}}' | sort > "$BACKUP_DIR/container-ids.after"
comm -3 "$BACKUP_DIR/container-ids.before" "$BACKUP_DIR/container-ids.after" > "$BACKUP_DIR/container-turnover.txt"
docker info >/dev/null 2>&1
MODIFIED=0
: > "$BACKUP_DIR/COMPLETED"
chmod 0600 "$BACKUP_DIR/COMPLETED"

printf 'Docker client upgrade verified. Backup: %s\n' "$BACKUP_DIR"
printf 'Manual rollback: sudo bash %s --rollback %s\n' "$0" "$BACKUP_DIR"
docker --version
docker buildx version
docker compose version --short

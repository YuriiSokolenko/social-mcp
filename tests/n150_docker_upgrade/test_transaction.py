"""End-to-end tests for the N150 Docker client upgrade using command mocks.

The installer copy redirects every managed path into tmp_path and replaces the
host identity preflight. All package, Docker, download, and install commands are
test doubles. The host Docker daemon and package database are never contacted.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "scripts/upgrade-n150-docker-client.sh"
OLD_BUILDX = "0.34.1-1~ubuntu.26.04~resolute"
OLD_COMPOSE = "5.1.4-1~ubuntu.26.04~resolute"
NEW_BUILDX = "0.38.0-1~ubuntu.26.04~resolute"
NEW_COMPOSE = "5.6.0-1~ubuntu.26.04~resolute"
OLD_CLI = "Docker version 29.5.3, build mock"
NEW_CLI = "Docker version 29.9.0, build mock"


def _write_executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(0o755)


def _state(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        key, value = line.split("=", 1)
        result[key] = value
    return result


def _write_state(path: Path, *, buildx: str, compose: str) -> None:
    path.write_text(f"BUILDX={buildx}\nCOMPOSE={compose}\n")


def _test_env(root: Path, overrides: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "N150_ROOT": str(root),
            "N150_STATE": str(root / "state"),
            "N150_APT_LOG": str(root / "apt.log"),
            "N150_OLD_DOCKER": str(root / "old/docker"),
            "N150_NEW_DOCKER": str(root / "usr/local/lib/docker-cli/29.9.0/docker"),
            "N150_CLI_ARCHIVE": str(root / "cli.tgz"),
            "PATH": f"{root}/usr/local/bin:{root}/mockbin:{env['PATH']}",
        }
    )
    if overrides:
        env.update(overrides)
    return env


def _prepare(root: Path) -> dict[str, str]:
    mockbin = root / "mockbin"
    local_bin = root / "usr/local/bin"
    cli_root = root / "usr/local/lib/docker-cli/29.9.0"
    backup_root = root / "var/backups/n150-docker-client-upgrade"
    for directory in (mockbin, local_bin, cli_root, backup_root, root / "old"):
        directory.mkdir(parents=True, exist_ok=True)
    backup_root.chmod(0o700)

    docker_stub = r'''#!/usr/bin/env bash
set -euo pipefail
source "$N150_STATE"
resolved="$(readlink -f -- "$0")"
if [[ "$resolved" == "$N150_NEW_DOCKER" ]]; then
  cli='Docker version 29.9.0, build mock'
else
  cli='Docker version 29.5.3, build mock'
fi
case "${1:-}" in
  --version) echo "$cli" ;;
  buildx) echo "github.com/docker/buildx v${BUILDX%%-*}" ;;
  compose) [[ "${2:-}" == version && "${3:-}" == --short ]] && echo "${COMPOSE%%-*}" ;;
  version) echo 28.0.0 ;;
  info)
    if [[ "${FAIL_VERIFY_ONCE:-}" == yes && "$BUILDX" == '0.38.0-1~ubuntu.26.04~resolute' && ! -e "$N150_ROOT/verify-failed" ]]; then
      : > "$N150_ROOT/verify-failed"
      exit 1
    fi
    ;;
  ps)
    if [[ "$BUILDX" == '0.38.0-1~ubuntu.26.04~resolute' ]]; then printf 'container-b\ncontainer-c\n';
    else printf 'container-a\ncontainer-b\n'; fi
    ;;
  *) exit 2 ;;
esac
'''
    _write_executable(root / "old/docker", docker_stub)
    (local_bin / "docker").symlink_to(root / "old/docker")

    _write_executable(
        mockbin / "dpkg-query",
        r'''#!/usr/bin/env bash
source "$N150_STATE"
case "$3" in
  docker-buildx-plugin) printf '%s' "$BUILDX" ;;
  docker-compose-plugin) printf '%s' "$COMPOSE" ;;
  *) exit 1 ;;
esac
''',
    )
    _write_executable(
        mockbin / "apt-cache",
        r'''#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  policy) printf '  Installed: (none)\n  Candidate: 0.39.0-1~ubuntu.26.04~resolute\n' ;;
  show)
    spec="$2"
    [[ "${MISSING_PIN:-}" == "$spec" ]] && exit 0
    sum="$(printf '%s' "$spec" | sha256sum | awk '{print $1}')"
    printf 'Package: %s\nVersion: %s\nSHA256: %s\n' "${spec%%=*}" "${spec#*=}" "$sum"
    if [[ "${LARGE_APT_OUTPUT:-}" == yes ]]; then
      dd if=/dev/zero bs=65536 count=64 status=none | tr '\0' x
    fi
    ;;
  *) exit 2 ;;
esac
''',
    )
    _write_executable(
        mockbin / "apt-get",
        r'''#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$N150_APT_LOG"
case "$1" in
  update) [[ "${APT_FAIL:-}" != update ]] ;;
  -s) printf 'Inst docker-buildx-plugin [old] (target)\nInst docker-compose-plugin [old] (target)\n' ;;
  download)
    spec="$2"; package="${spec%%=*}"; version="${spec#*=}"
    printf '%s' "$spec" > "${package}_${version}.deb"
    ;;
  install)
    if [[ "${APT_FAIL:-}" == install ]]; then exit 23; fi
    if [[ "${APT_FAIL:-}" == partial ]]; then
      python3 - "$N150_STATE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = p.read_text().splitlines()
p.write_text('\\n'.join(('BUILDX=0.38.0-1~ubuntu.26.04~resolute' if x.startswith('BUILDX=') else x) for x in lines) + '\\n')
PY
      exit 24
    fi
    printf 'BUILDX=0.38.0-1~ubuntu.26.04~resolute\nCOMPOSE=5.6.0-1~ubuntu.26.04~resolute\n' > "$N150_STATE"
    ;;
  *) exit 2 ;;
esac
''',
    )
    _write_executable(
        mockbin / "dpkg",
        r'''#!/usr/bin/env bash
set -euo pipefail
if [[ "${ROLLBACK_FAIL:-}" == yes ]]; then exit 41; fi
printf 'BUILDX=0.34.1-1~ubuntu.26.04~resolute\nCOMPOSE=5.1.4-1~ubuntu.26.04~resolute\n' > "$N150_STATE"
''',
    )
    _write_executable(
        mockbin / "curl",
        r'''#!/usr/bin/env bash
set -euo pipefail
cp "$N150_CLI_ARCHIVE" "${@: -1}"
''',
    )
    real_install = shutil.which("install")
    assert real_install
    _write_executable(
        mockbin / "install",
        f'''#!/usr/bin/env bash
set -euo pipefail
if [[ "${{CLI_INSTALL_FAIL:-}}" == yes && "${{@: -1}}" == "$N150_NEW_DOCKER" ]]; then exit 31; fi
args=()
while (($#)); do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec {real_install} "${{args[@]}}"
''',
    )

    # A tiny valid archive stands in for Docker's official static CLI archive.
    staged = root / "archive/docker"
    staged.mkdir(parents=True)
    _write_executable(staged / "docker", docker_stub)
    subprocess.run(
        ["tar", "-czf", str(root / "cli.tgz"), "-C", str(root / "archive"), "docker/docker"],
        check=True,
    )
    _write_state(root / "state", buildx=OLD_BUILDX, compose=OLD_COMPOSE)

    source = INSTALLER.read_text()
    source = source.replace(
        "readonly BACKUP_ROOT='/var/backups/n150-docker-client-upgrade'",
        f"readonly BACKUP_ROOT='{backup_root}'",
    )
    source = source.replace("readonly CLI_ROOT='/usr/local/lib/docker-cli/29.9.0'", f"readonly CLI_ROOT='{cli_root}'")
    source = source.replace("readonly CLI_BINARY=\"$CLI_ROOT/docker\"", f"readonly CLI_BINARY='{cli_root}/docker'")
    source = source.replace("readonly CLI_LINK='/usr/local/bin/docker'", f"readonly CLI_LINK='{local_bin}/docker'")
    source = source.replace(
        'install -d -o root -g root -m 0755 /usr/local/lib/docker-cli "$CLI_ROOT"',
        f'install -d -o root -g root -m 0755 {root / "usr/local/lib/docker-cli"} "$CLI_ROOT"',
    )
    archive_hash = hashlib.sha256((root / "cli.tgz").read_bytes()).hexdigest()
    import re

    source = re.sub(r"readonly CLI_SHA256='[0-9a-f]{64}'", f"readonly CLI_SHA256='{archive_hash}'", source)
    source = source.replace(
        '  [[ "$(stat -c \'%u\' -- "$path")" == 0 ]] || return 1',
        '  [[ -d "$path" ]] || return 1 # fixture directories belong to the test user',
    )
    source = source.replace(
        '  [[ "$EUID" -eq 0 ]] || { printf \'Rollback requires root. Backups retained at %s\\n\' "$dir" >&2; return 1; }',
        '  : # fixture simulates the root-only rollback operation',
    )

    # Keep transaction logic intact while redirecting managed paths and
    # simulating root-only ownership checks for unprivileged test runners.
    preflight_start = source.index('[[ "$(hostname -s)"')
    recover_start = source.index("# Recover an interrupted previous run")
    fixture_preflight = '''PATH_DOCKER="$(command -v docker)"
PREVIOUS_CLI_EFFECTIVE="$(readlink -f -- "$PATH_DOCKER")"
PREVIOUS_CLI_VERSION="$($PATH_DOCKER --version)"
PREVIOUS_LINK_PRESENT=yes
PREVIOUS_LINK_TEXT="$(readlink -- "$CLI_LINK")"
CLI_BINARY_PREEXISTING=no
current_buildx="$(package_version "$BUILDX_PACKAGE")"
current_compose="$(package_version "$COMPOSE_PACKAGE")"
server_version_before="$(docker version --format '{{.Server.Version}}')"
'''
    source = source[:preflight_start] + fixture_preflight + source[recover_start:]
    test_installer = root / "installer-under-test.sh"
    test_installer.write_text(source)
    test_installer.chmod(0o755)
    return _test_env(root)


def _run(root: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(root / "installer-under-test.sh")],
        cwd=root,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=30,
    )


def _assert_rolled_back(root: Path) -> None:
    assert _state(root / "state") == {"BUILDX": OLD_BUILDX, "COMPOSE": OLD_COMPOSE}
    assert os.readlink(root / "usr/local/bin/docker") == str(root / "old/docker")


def test_successful_install_records_ephemeral_container_turnover_and_reruns_idempotently(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    first = _run(tmp_path, env)
    assert first.returncode == 0, first.stdout
    assert _state(tmp_path / "state") == {"BUILDX": NEW_BUILDX, "COMPOSE": NEW_COMPOSE}
    assert os.readlink(tmp_path / "usr/local/bin/docker") == str(tmp_path / "usr/local/lib/docker-cli/29.9.0/docker")
    backup = next((tmp_path / "var/backups/n150-docker-client-upgrade").iterdir())
    assert (backup / "COMPLETED").exists()
    assert (backup / "container-turnover.txt").read_text() == "container-a\n\tcontainer-c\n"
    apt_log = (tmp_path / "apt.log").read_text()
    assert (
        f"install -y --no-install-recommends --only-upgrade docker-buildx-plugin={NEW_BUILDX} "
        f"docker-compose-plugin={NEW_COMPOSE}"
    ) in apt_log
    assert "policy docker-buildx-plugin" not in apt_log
    before = (tmp_path / "apt.log").read_text().count("install -y")
    second = _run(tmp_path, env)
    assert second.returncode == 0, second.stdout
    assert "Already at target versions; no changes made." in second.stdout
    assert (tmp_path / "apt.log").read_text().count("install -y") == before


@pytest.mark.parametrize("failure", ["update", "install", "partial"])
def test_apt_failures_do_not_leave_partial_upgrade(tmp_path: Path, failure: str) -> None:
    env = _prepare(tmp_path)
    env["APT_FAIL"] = failure
    result = _run(tmp_path, env)
    assert result.returncode != 0
    _assert_rolled_back(tmp_path)
    if failure == "update":
        assert "Automatic rollback" not in result.stdout
        assert not list((tmp_path / "var/backups/n150-docker-client-upgrade").iterdir())
    else:
        assert "Automatic rollback verified successfully" in result.stdout


def test_missing_exact_pin_fails_before_mutation(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    env["MISSING_PIN"] = f"docker-buildx-plugin={NEW_BUILDX}"
    result = _run(tmp_path, env)
    assert result.returncode != 0
    assert "exact package version or SHA-256 metadata unavailable" in result.stdout
    _assert_rolled_back(tmp_path)


def test_large_exact_apt_metadata_is_consumed_without_sigpipe(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    env["LARGE_APT_OUTPUT"] = "yes"
    result = _run(tmp_path, env)
    assert result.returncode == 0, result.stdout
    assert _state(tmp_path / "state") == {"BUILDX": NEW_BUILDX, "COMPOSE": NEW_COMPOSE}


def test_cli_install_failure_rolls_back_packages_and_cli_link(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    env["CLI_INSTALL_FAIL"] = "yes"
    result = _run(tmp_path, env)
    assert result.returncode != 0
    _assert_rolled_back(tmp_path)
    assert "Automatic rollback verified successfully" in result.stdout


def test_post_install_verification_failure_rolls_back(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    env["FAIL_VERIFY_ONCE"] = "yes"
    result = _run(tmp_path, env)
    assert result.returncode != 0
    _assert_rolled_back(tmp_path)
    assert "Automatic rollback verified successfully" in result.stdout


def test_rollback_failure_is_reported_and_backups_are_retained(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    env.update(APT_FAIL="install", ROLLBACK_FAIL="yes")
    result = _run(tmp_path, env)
    assert result.returncode != 0
    assert "Automatic rollback FAILED" in result.stdout
    backup = next((tmp_path / "var/backups/n150-docker-client-upgrade").iterdir())
    assert backup.exists()


def test_rollback_refuses_missing_archives_and_checksum_tampering(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    untrusted = tmp_path / "untrusted-rollback"
    untrusted.mkdir()
    (untrusted / "manifest").write_text('touch "$N150_ROOT/manifest-executed"\n')
    (untrusted / "SHA256SUMS").write_text("")
    rejected = subprocess.run(
        ["bash", str(tmp_path / "installer-under-test.sh"), "--rollback", str(untrusted)],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    assert rejected.returncode != 0
    assert "Invalid backup directory" in rejected.stdout
    assert not (tmp_path / "manifest-executed").exists()

    installed = _run(tmp_path, env)
    assert installed.returncode == 0, installed.stdout
    backup = next((tmp_path / "var/backups/n150-docker-client-upgrade").iterdir())
    package = next((backup / "installed").glob("docker-buildx-plugin_*.deb"))
    package.unlink()
    remaining = subprocess.run(
        ["find", "installed", "target", "-type", "f", "(", "-name", "*.deb", "-o", "-name", "*.tgz", ")", "-print0"],
        cwd=backup,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    files = [Path(os.fsdecode(item)) for item in remaining.split(b"\0") if item]
    checksums = subprocess.run(["sha256sum", *map(str, files)], cwd=backup, check=True, text=True, stdout=subprocess.PIPE).stdout
    (backup / "SHA256SUMS").write_text(checksums)
    missing = subprocess.run(
        ["bash", str(tmp_path / "installer-under-test.sh"), "--rollback", str(backup)],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    assert missing.returncode != 0
    assert "Rollback packages are incomplete" in missing.stdout

    # Restore the package archive, then make the recorded bytes disagree with it.
    package.write_text(f"docker-buildx-plugin={OLD_BUILDX}")
    (backup / "SHA256SUMS").write_text("0" * 64 + "  missing.deb\n")
    corrupted = subprocess.run(
        ["bash", str(tmp_path / "installer-under-test.sh"), "--rollback", str(backup)],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    assert corrupted.returncode != 0
    assert "Rollback artifact checksum verification failed" in corrupted.stdout


def test_manual_rollback_refuses_unexpected_cli_symlink(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    installed = _run(tmp_path, env)
    assert installed.returncode == 0, installed.stdout
    backup = next((tmp_path / "var/backups/n150-docker-client-upgrade").iterdir())
    link = tmp_path / "usr/local/bin/docker"
    link.unlink()
    link.symlink_to(tmp_path / "unowned-docker")
    result = subprocess.run(
        ["bash", str(tmp_path / "installer-under-test.sh"), "--rollback", str(backup)],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    assert result.returncode != 0
    assert "Refusing to replace unexpected path during rollback" in result.stdout
    assert os.readlink(link) == str(tmp_path / "unowned-docker")


def test_interrupted_run_marker_is_recovered_before_new_upgrade(tmp_path: Path) -> None:
    env = _prepare(tmp_path)
    state = tmp_path / "state"
    _write_state(state, buildx=NEW_BUILDX, compose=NEW_COMPOSE)
    new_cli = tmp_path / "usr/local/lib/docker-cli/29.9.0/docker"
    shutil.copy2(tmp_path / "archive/docker/docker", new_cli)
    (tmp_path / "usr/local/bin/docker").unlink()
    (tmp_path / "usr/local/bin/docker").symlink_to(new_cli)
    backup = tmp_path / "var/backups/n150-docker-client-upgrade/interrupted"
    installed = backup / "installed"
    installed.mkdir(parents=True, mode=0o700)
    old_buildx = installed / f"docker-buildx-plugin_{OLD_BUILDX}.deb"
    old_compose = installed / f"docker-compose-plugin_{OLD_COMPOSE}.deb"
    old_buildx.write_text(f"docker-buildx-plugin={OLD_BUILDX}")
    old_compose.write_text(f"docker-compose-plugin={OLD_COMPOSE}")
    (backup / "manifest").write_text(
        "\n".join(
            [
                f"PREVIOUS_BUILDX='{OLD_BUILDX}'",
                f"PREVIOUS_COMPOSE='{OLD_COMPOSE}'",
                "PREVIOUS_BUILDX_EXECUTABLE_VERSION='v0.34.1'",
                "PREVIOUS_COMPOSE_EXECUTABLE_VERSION='5.1.4'",
                f"PREVIOUS_CLI_VERSION='{OLD_CLI}'",
                f"PREVIOUS_CLI_EFFECTIVE='{tmp_path}/old/docker'",
                f"PREVIOUS_COMMAND='{tmp_path}/usr/local/bin/docker'",
                "PREVIOUS_LINK_PRESENT='yes'",
                f"PREVIOUS_LINK_TEXT='{tmp_path}/old/docker'",
                "CLI_BINARY_PREEXISTING='no'",
                "SERVER_VERSION='28.0.0'",
                f"CLI_NEW_BINARY_SHA256='{hashlib.sha256(new_cli.read_bytes()).hexdigest()}'",
                "",
            ]
        )
    )
    sums = subprocess.run(
        ["sha256sum", str(old_buildx), str(old_compose)],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    ).stdout
    # SHA256SUMS entries are interpreted relative to the backup directory.
    sums = "".join(f"{line.split(maxsplit=1)[0]}  installed/{Path(line.split(maxsplit=1)[1]).name}\n" for line in sums.splitlines())
    (backup / "SHA256SUMS").write_text(sums)
    (backup / "MODIFICATION_STARTED").touch()

    result = _run(tmp_path, env)
    assert result.returncode == 0, result.stdout
    assert "Recovering interrupted upgrade" in result.stdout
    assert (backup / "RECOVERED").exists()
    assert _state(state) == {"BUILDX": NEW_BUILDX, "COMPOSE": NEW_COMPOSE}

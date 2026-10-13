#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 1001 ] || { echo 'Worker must run as UID 1001' >&2; exit 1; }
[ ! -e /var/run/docker.sock ] || { echo 'Worker must not mount Docker socket' >&2; exit 1; }
! command -v sudo >/dev/null || { echo 'Worker must not contain sudo' >&2; exit 1; }
java -version
node -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)'
python3 -c 'import sys, ssl, venv; assert sys.version_info[:2] == (3, 12)'
git --version
# Keep the active kernel filters visible in startup logs so a fail-closed bwrap
# error can be distinguished from a missing binary/runtime before deployment.
seccomp_mode="$(awk '/^Seccomp:/ {print $2}' /proc/self/status)"
no_new_privs="$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)"
apparmor_profile="unavailable"
if [ -r /proc/self/attr/current ]; then
  apparmor_profile="$(cat /proc/self/attr/current)"
fi
printf 'security profile: apparmor=%s seccomp=%s no_new_privs=%s\n' \
  "$apparmor_profile" "${seccomp_mode:-unknown}" "${no_new_privs:-unknown}"
# Exactly the downstream workflow probe. Keep Docker's default seccomp and
# AppArmor profiles: failure is a deployment blocker, never a reason to relax them.
/usr/bin/bwrap --die-with-parent --new-session --unshare-all \
  --tmpfs / --proc /proc --dev /dev \
  --ro-bind /usr /usr --ro-bind /bin /bin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 -- /usr/bin/true
printf 'recursive-coder worker prerequisites passed\n'

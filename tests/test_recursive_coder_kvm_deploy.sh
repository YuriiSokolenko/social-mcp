#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
compose="$root/infra/github-runner-autoscaler/compose.yaml"
deploy="$root/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh"
grep -Fq 'mem_limit: 5120m' "$compose"
grep -Fq 'memswap_limit: 8192m' "$compose"
grep -Fq 'assert h["MemorySwap"] == 8192 * 1024 * 1024' "$deploy"
grep -Fq 'policy.nano_cpus_within_limit(h.get("NanoCpus"))' "$deploy"
grep -Fq 'if [ -f "$state/previous-image-candidate" ]; then' "$deploy"
grep -Fq 'docker image inspect "$previous_image"' "$deploy"
grep -Fq "find \"\$state_dir\" -mindepth 1 -maxdepth 1 -type d -name 'n150-rc-eph-*'" "$deploy"
grep -Fq 'env_file="${2:-$root/infra/github-runner-autoscaler/.env}"' "$deploy"
grep -Fq 'up -d --no-deps "$service"' "$deploy"
grep -Fq 'golden="$golden_dir/$golden_name"' "$deploy"
grep -Fq 'KVM_GOLDEN_FILENAME' "$deploy"
grep -Fq 'KVM_GOLDEN_SHA256' "$deploy"
if grep -Eq 'docker (restart|prune)|sysctl|apparmor_parser|seccomp' "$deploy"; then
  echo 'deployment script must not restart/prune Docker or alter host security policy' >&2; exit 1
fi
tmp="$(mktemp -d)"
cleanup() {
  python3 - "$tmp" <<'PY'
from pathlib import Path
import shutil, sys
shutil.rmtree(Path(sys.argv[1]), ignore_errors=True)
PY
}
trap cleanup EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/docker" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>"$DOCKER_CALLS"
case "$*" in
  info|compose\ *\ config\ --quiet) exit 0 ;;
  *) exit 90 ;;
esac
SH
chmod 0755 "$tmp/bin/docker"
cat >"$tmp/owner.env" <<'ENV'
KVM_GOLDEN_HOST_DIR=/var/lib/recursive-coder-kvm/golden
KVM_STATE_HOST_DIR=/var/lib/recursive-coder-kvm/state
ENV
chmod 0600 "$tmp/owner.env"

export DOCKER_CALLS="$tmp/docker-calls"
PATH="$tmp/bin:$PATH" bash "$root/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh" \
  --dry-run "$tmp/owner.env" >"$tmp/output" 2>&1 && {
    echo 'deployment preflight passed without prepared golden assets' >&2; exit 1;
  }
grep -Fq 'Run prepare-recursive-coder-kvm.sh first' "$tmp/output"
[ ! -e "$DOCKER_CALLS" ] || { echo 'preflight reached Docker before prepared assets' >&2; exit 1; }
if grep -Fq 'curl -fL' "$root/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh"; then
  echo 'deployment must not download or stage golden images' >&2; exit 1
fi

cat >>"$tmp/owner.env" <<'ENV'
KVM_GOLDEN_FILENAME=../../etc/passwd
ENV
if PATH="$tmp/bin:$PATH" bash "$deploy" --dry-run "$tmp/owner.env" >"$tmp/path-output" 2>&1; then
  echo 'path-traversal golden filename was accepted' >&2; exit 1
fi
grep -Fq 'KVM_GOLDEN_FILENAME must be' "$tmp/path-output"
[ ! -e "$DOCKER_CALLS" ] || { echo 'invalid image selection reached Docker' >&2; exit 1; }
sed -i '/KVM_GOLDEN_FILENAME=/d' "$tmp/owner.env"

chmod 0644 "$tmp/owner.env"
if PATH="$tmp/bin:$PATH" bash "$root/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh" \
  --dry-run "$tmp/owner.env" >"$tmp/rejected-output" 2>&1; then
  echo 'readable secret env file was accepted' >&2; exit 1
fi

echo 'recursive-coder KVM deployment checks passed'

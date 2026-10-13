#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
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

chmod 0644 "$tmp/owner.env"
if PATH="$tmp/bin:$PATH" bash "$root/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh" \
  --dry-run "$tmp/owner.env" >"$tmp/rejected-output" 2>&1; then
  echo 'readable secret env file was accepted' >&2; exit 1
fi

echo 'recursive-coder KVM deployment checks passed'

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
  --dry-run "$tmp/owner.env" >"$tmp/output"
grep -Fq 'Read-only KVM preflight passed' "$tmp/output"
[[ "$(wc -l <"$DOCKER_CALLS" | tr -d ' ')" = 2 ]] || {
  echo 'dry-run performed an unexpected Docker action' >&2; exit 1;
}
grep -Fxq 'info' "$DOCKER_CALLS"
grep -Fq 'compose --project-name recursive-coder-kvm' "$DOCKER_CALLS"

chmod 0644 "$tmp/owner.env"
if PATH="$tmp/bin:$PATH" bash "$root/infra/github-runner-autoscaler/deploy-recursive-coder-kvm.sh" \
  --dry-run "$tmp/owner.env" >"$tmp/rejected-output" 2>&1; then
  echo 'readable secret env file was accepted' >&2; exit 1
fi

echo 'recursive-coder KVM deployment checks passed'

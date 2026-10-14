#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
builder="$root/infra/github-runner-autoscaler/build-recursive-coder-kvm-golden.sh"
fail(){ echo "FAIL: $*" >&2; exit 1; }
bash -n "$builder" || fail 'builder shell syntax is invalid'
grep -Fq 'restrict=on,ipv6=off' "$builder" || fail 'QEMU guest networking is not restricted'
grep -Fq 'kvm-egress-proxy.py' "$builder" || fail 'builder omits repository allowlist proxy'
grep -Fq 'actions-runner-linux-x64-2.338.0.tar.gz' "$builder" || fail 'pinned Actions runner archive is missing'
grep -Fq 'sha256sum -c -' "$builder" || fail 'runner archive checksum is not verified'
grep -Fq 'prepared.manifest' "$builder" || fail 'prepared guest manifest is missing'
grep -Fq 'BUILDER_BWRAP_PROBE=PASS' "$builder" || fail 'unprivileged Bubblewrap probe is missing'
grep -Fq 'cloud-init clean --logs --machine-id --seed' "$builder" || fail 'cloud-init identity is not cleaned before image capture'
grep -Fq 'PROMOTED_FILENAME=' "$builder" || fail 'digest-named promotion is missing'
grep -Fq 'chmod 0444' "$builder" || fail 'candidate is not made read-only'
grep -Fq 'mv -nT -- "$promote_image_tmp" "$target"' "$builder" || fail 'promotion is not atomic and no-replace'
if grep -E 'hostfwd|virtiofs|9p|docker.sock|ACTIONS_RUNNER_INPUT_TOKEN|RECURSIVE_CODER_GH_ADMIN_TOKEN' "$builder"; then
  fail 'builder exposes host forwarding, shared filesystems or runner credentials'
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/out"
printf 'wrong pinned source\n' >"$tmp/wrong.img"
chmod 0444 "$tmp/wrong.img"
if KVM_BUILDER_BASE_IMAGE="$tmp/wrong.img" KVM_BUILDER_OUTPUT_DIR="$tmp/out" bash "$builder" --dry-run >"$tmp/output" 2>&1; then
  fail 'builder preflight accepted an unpinned base image'
fi
grep -Fq 'stock image digest mismatch' "$tmp/output" || fail 'wrong base checksum was not rejected'
[ -z "$(find "$tmp/out" -mindepth 1 -print -quit)" ] || fail 'failed dry-run modified output directory'
echo 'recursive-coder KVM golden builder checks passed'

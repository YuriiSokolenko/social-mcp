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
grep -Fq 'emit_keys_to_console' "$builder" || fail 'cloud-init must not print ephemeral host keys to the serial log'
grep -Fq 'REDACTED PRIVATE KEY BLOCK' "$builder" || fail 'failure diagnostics must redact private key blocks'
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
grep -Fq 'stock image digest mismatch' "$tmp/output" || fail 'read-only source was rejected before checksum verification'
[ -z "$(find "$tmp/out" -mindepth 1 -print -quit)" ] || fail 'failed dry-run modified output directory'
printf 'writable source\n' >"$tmp/writable.img"
chmod 0644 "$tmp/writable.img"
if KVM_BUILDER_BASE_IMAGE="$tmp/writable.img" KVM_BUILDER_OUTPUT_DIR="$tmp/out" bash "$builder" --dry-run >"$tmp/output" 2>&1; then
  fail 'builder accepted a source image with write permission bits'
fi
grep -Fq 'stock image has write permission bits' "$tmp/output" || fail 'writable source was not rejected by mode-bit validation'
if KVM_BUILDER_BASE_IMAGE="$tmp/missing.img" KVM_BUILDER_OUTPUT_DIR="$tmp/out" bash "$builder" --dry-run >"$tmp/output" 2>&1; then
  fail 'builder accepted a missing source image'
fi
grep -Fq 'readable regular non-symlink' "$tmp/output" || fail 'missing source was not rejected clearly'
ln -s "$tmp/writable.img" "$tmp/symlink.img"
if KVM_BUILDER_BASE_IMAGE="$tmp/symlink.img" KVM_BUILDER_OUTPUT_DIR="$tmp/out" bash "$builder" --dry-run >"$tmp/output" 2>&1; then
  fail 'builder accepted a symlink source image'
fi
grep -Fq 'readable regular non-symlink' "$tmp/output" || fail 'symlink source was not rejected clearly'
[ -z "$(find "$tmp/out" -mindepth 1 -print -quit)" ] || fail 'failed preflight modified output directory'
# Optional pinned image exercises the root/0444 failure mode without embedding it in fixtures.
if [[ -n "${KVM_BUILDER_TEST_PINNED_IMAGE:-}" ]]; then
  pinned_output="${KVM_BUILDER_TEST_OUTPUT_DIR:-$tmp/out}"
  mkdir -p "$pinned_output"
  KVM_BUILDER_BASE_IMAGE="$KVM_BUILDER_TEST_PINNED_IMAGE" KVM_BUILDER_OUTPUT_DIR="$pinned_output" bash "$builder" --dry-run >"$tmp/output" 2>&1 || { cat "$tmp/output" >&2; fail 'builder rejected the staged pinned read-only image'; }
  grep -Fq 'Read-only preflight passed' "$tmp/output" || fail 'pinned dry-run did not complete'
fi
echo 'recursive-coder KVM golden builder checks passed'

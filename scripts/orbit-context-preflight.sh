#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: orbit-context-preflight.sh <indexed-repository> [file-target test-file-target [directory-target ...]]" >&2
  exit 2
fi

repo_root="$1"
shift
if [[ ! -d "$repo_root/.git" && ! -f "$repo_root/.git" ]]; then
  echo "Orbit context preflight: not a Git worktree: $repo_root" >&2
  exit 2
fi
if ! command -v orbit >/dev/null 2>&1; then
  echo "Orbit context preflight: orbit is not installed on PATH" >&2
  exit 1
fi

cd "$repo_root"
repo_root="$(pwd -P)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
  local target="$1"
  local message="$2"
  echo "Orbit context preflight failed for '$target': $message" >&2
  printf 'Orbit binary: %s\n' "$(command -v orbit)" >&2
  printf 'Orbit version: %s\n' "$(orbit version 2>&1 | head -n 1)" >&2
  printf 'Worktree HEAD: %s\n' "$(git rev-parse HEAD 2>&1)" >&2
  printf 'HOME: %s\n' "${HOME:-<unset>}" >&2
  printf 'DuckDB extension cache: %s\n' "${HOME:-}/.duckdb/extensions" >&2
  if [[ -d "${HOME:-}/.duckdb/extensions" ]]; then
    ls -laR "${HOME}/.duckdb/extensions" >&2 || true
  fi
  if [[ -s "$tmp_dir/stderr" ]]; then
    cat "$tmp_dir/stderr" >&2
  fi
  exit 1
}

expected_head="$(git rev-parse HEAD)"
if ! orbit list -F json >"$tmp_dir/index.json" 2>"$tmp_dir/stderr"; then
  fail "$repo_root" "orbit list could not verify the indexed worktree"
fi
if ! python3 - "$repo_root" "$expected_head" "$tmp_dir/index.json" <<'PY'
import json
import os
import sys

root, head, index_path = sys.argv[1:]
try:
    with open(index_path, encoding="utf-8") as index_file:
        rows = json.load(index_file)
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
raise SystemExit(0 if any(
    os.path.realpath(row.get("repo_path", "")) == root
    and row.get("commit_sha") == head
    and row.get("status") == "indexed"
    for row in rows if isinstance(row, dict)
) else 1)
PY
then
  fail "$repo_root" "Orbit index is not marked indexed at current HEAD $expected_head"
fi
printf 'Orbit index preflight passed: %s at HEAD %s\n' "$repo_root" "$expected_head"

pick_tracked_file() {
  local directory="$1"
  local candidate
  while IFS= read -r candidate; do
    if [[ -f "$candidate" && "$candidate" != */__init__.py ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(git ls-files "$directory/*.py" "$directory/**/*.py")
  return 1
}

file_target="${1:-}"
test_file_target="${2:-}"
if [[ ! -f "$file_target" ]]; then
  file_target="$(pick_tracked_file src || true)"
fi
if [[ ! -f "$test_file_target" ]]; then
  test_file_target="$(pick_tracked_file tests || true)"
fi
if [[ $# -gt 2 ]]; then
  shift 2
  directory_targets=("$@")
else
  directory_targets=()
  [[ -d src ]] && directory_targets+=(src)
  [[ -d tests ]] && directory_targets+=(tests)
  ((${#directory_targets[@]})) || directory_targets+=(.)
fi

targets=()
if [[ -n "$file_target" ]]; then
  targets+=("$file_target")
else
  fail "$repo_root" "no tracked source file is available for context verification"
fi
if [[ -n "$test_file_target" ]]; then
  targets+=("$test_file_target")
else
  fail "$repo_root" "no tracked test file is available for context verification"
fi
targets+=("${directory_targets[@]}")

for target in "${targets[@]}"; do
  if [[ ! -e "$target" ]]; then
    fail "$target" "target does not exist in the indexed worktree"
  fi
  : > "$tmp_dir/stderr"
  if orbit context "$target" >"$tmp_dir/stdout" 2>"$tmp_dir/stderr"; then
    :
  else
    status=$?
    fail "$target" "orbit context exited with status $status"
  fi
  if [[ ! -s "$tmp_dir/stdout" ]]; then
    fail "$target" "orbit context returned empty output"
  fi
  printf 'Orbit context preflight passed: %s (%s bytes)\n' \
    "$target" "$(wc -c < "$tmp_dir/stdout" | tr -d ' ')"
done

if [[ "$(git rev-parse HEAD)" != "$expected_head" ]]; then
  fail "$repo_root" "worktree HEAD changed while context was being checked"
fi

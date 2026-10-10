#!/usr/bin/env bash
set -euo pipefail

ZOEKT_ROOT="${ZOEKT_ROOT:-/home/yurasik/zoekt-social-mcp}"
ZOEKT_IMAGE="${ZOEKT_IMAGE:-ghcr.io/sourcegraph/zoekt@sha256:f19dac0fa75e51a6c37fb619983d2ad026b951cb67d6ef837c31696605d75461}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CONFIG_PATH="${AGENT_HARNESS_CONFIG:-$SCRIPT_DIR/../../.agent-harness.json}"
command -v jq >/dev/null 2>&1 || { printf 'Zoekt: jq is required to read git.defaultBranch\n' >&2; exit 1; }
DEFAULT_BRANCH="$(jq -er '.git.defaultBranch | select(type == "string" and length > 0)' "$CONFIG_PATH")" || { printf 'Zoekt: cannot read configured git.defaultBranch\n' >&2; exit 1; }
[[ "$DEFAULT_BRANCH" != -* ]] && git check-ref-format --branch "$DEFAULT_BRANCH" >/dev/null 2>&1 || { printf 'Zoekt: configured git.defaultBranch is invalid\n' >&2; exit 1; }
REPO_URL="https://github.com/YuriiSokolenko/social-mcp.git"
mkdir -p "$ZOEKT_ROOT/mirror" "$ZOEKT_ROOT/index"
exec 9>"$ZOEKT_ROOT/update.lock"
flock -n 9 || exit 0

if [ ! -f "$ZOEKT_ROOT/mirror/config" ]; then
  rmdir "$ZOEKT_ROOT/mirror" 2>/dev/null || true
  git clone --bare --single-branch --branch "$DEFAULT_BRANCH" "$REPO_URL" "$ZOEKT_ROOT/mirror"
else
  GIT_TERMINAL_PROMPT=0 git --git-dir="$ZOEKT_ROOT/mirror" fetch --prune origin "+refs/heads/${DEFAULT_BRANCH}:refs/heads/${DEFAULT_BRANCH}"
fi

commit=$(git --git-dir="$ZOEKT_ROOT/mirror" rev-parse "refs/heads/${DEFAULT_BRANCH}")
printf 'Zoekt: indexing repository=YuriiSokolenko/social-mcp branch=%s commit=%s\n' "$DEFAULT_BRANCH" "$commit"
docker run --rm --memory=2g --cpus=1.5 \
  -v "$ZOEKT_ROOT/mirror:/repo" \
  -v "$ZOEKT_ROOT/index:/data/index" \
  -v "$ZOEKT_ROOT/repo.meta.json:/config/repo.meta.json:ro" \
  --entrypoint zoekt-git-index "$ZOEKT_IMAGE" \
  -index /data/index -branches="$DEFAULT_BRANCH" -submodules=false -meta /config/repo.meta.json /repo
printf 'Zoekt: indexed commit=%s index=' "$commit"
du -sh "$ZOEKT_ROOT/index" | cut -f1

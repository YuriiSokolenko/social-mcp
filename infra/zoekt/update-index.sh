#!/usr/bin/env bash
set -euo pipefail

ZOEKT_ROOT="${ZOEKT_ROOT:-/home/yurasik/zoekt-social-mcp}"
ZOEKT_IMAGE="${ZOEKT_IMAGE:-ghcr.io/sourcegraph/zoekt@sha256:f19dac0fa75e51a6c37fb619983d2ad026b951cb67d6ef837c31696605d75461}"
REPO_URL="https://github.com/YuriiSokolenko/social-mcp.git"
mkdir -p "$ZOEKT_ROOT/mirror" "$ZOEKT_ROOT/index"
exec 9>"$ZOEKT_ROOT/update.lock"
flock -n 9 || exit 0

if [ ! -f "$ZOEKT_ROOT/mirror/config" ]; then
  rmdir "$ZOEKT_ROOT/mirror" 2>/dev/null || true
  git clone --bare --single-branch --branch dev "$REPO_URL" "$ZOEKT_ROOT/mirror"
else
  GIT_TERMINAL_PROMPT=0 git --git-dir="$ZOEKT_ROOT/mirror" fetch --prune origin +refs/heads/dev:refs/heads/dev
fi

commit=$(git --git-dir="$ZOEKT_ROOT/mirror" rev-parse refs/heads/dev)
printf 'Zoekt: indexing repository=YuriiSokolenko/social-mcp branch=dev commit=%s\n' "$commit"
docker run --rm --memory=2g --cpus=1.5 \
  -v "$ZOEKT_ROOT/mirror:/repo" \
  -v "$ZOEKT_ROOT/index:/data/index" \
  -v "$ZOEKT_ROOT/repo.meta.json:/config/repo.meta.json:ro" \
  --entrypoint zoekt-git-index "$ZOEKT_IMAGE" \
  -index /data/index -branches=dev -submodules=false -meta /config/repo.meta.json /repo
printf 'Zoekt: indexed commit=%s index=' "$commit"
du -sh "$ZOEKT_ROOT/index" | cut -f1

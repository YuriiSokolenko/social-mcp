#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${ISSUE:?ISSUE is required}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-}"
COMMENT="${2:-}"
if [[ "$ACTION" == "ensure" ]]; then
  node "$SCRIPT_DIR/pi-labels.mjs" issue
  exit 0
fi
exec node "$SCRIPT_DIR/pi-transition.mjs" issue "$ACTION" "$COMMENT"

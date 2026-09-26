#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${ISSUE:?ISSUE is required}"
ACTION="${1:-}"
COMMENT="${2:-}"
if [[ "$ACTION" == "ensure" ]]; then
  node scripts/pi-labels.mjs issue
  exit 0
fi
exec node scripts/pi-transition.mjs issue "$ACTION" "$COMMENT"

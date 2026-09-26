#!/usr/bin/env bash
set -euo pipefail
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${PR:?PR is required}"
ACTION="${1:-}"
COMMENT="${2:-}"
if [[ "$ACTION" == "ensure" ]]; then
  node scripts/pi-labels.mjs review
  exit 0
fi
exec node scripts/pi-transition.mjs review "$ACTION" "$COMMENT"

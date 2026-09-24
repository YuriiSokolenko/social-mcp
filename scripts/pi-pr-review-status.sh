#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${PR:?PR is required}"

ACTION="${1:-}"
COMMENT="${2:-}"

API="https://api.github.com/repos/${REPO}"
AUTH=(
  -H "Authorization: Bearer ${GH_TOKEN}"
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2022-11-28"
)

ensure_label() {
  local name="$1" color="$2" description="$3"
  if ! curl -fsS "${AUTH[@]}" "${API}/labels/$(printf '%s' "$name" | jq -sRr @uri)" >/dev/null 2>&1; then
    jq -n --arg name "$name" --arg color "$color" --arg description "$description"       '{name:$name,color:$color,description:$description}' |
      curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json"         --data-binary @- "${API}/labels" >/dev/null
  fi
}

remove_label() {
  local name="$1"
  curl -fsS -X DELETE "${AUTH[@]}"     "${API}/issues/${PR}/labels/$(printf '%s' "$name" | jq -sRr @uri)" >/dev/null 2>&1 || true
}

add_label() {
  local name="$1"
  jq -n --arg label "$name" '{labels:[$label]}' |
    curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json"       --data-binary @- "${API}/issues/${PR}/labels" >/dev/null
}

mark_commit() {
  local state="$1" description="$2"
  [ -n "${HEAD_SHA:-}" ] || return 0
  jq -n --arg state "$state" --arg context "social-mcp/pi-review" \
    --arg description "$description" \
    '{state:$state,context:$context,description:$description}' |
    curl --fail-with-body -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
      --data-binary @- "${API}/statuses/${HEAD_SHA}" >/dev/null
}

comment() {
  [ -z "$COMMENT" ] && return 0
  jq -n --arg body "$COMMENT" '{body:$body}' |
    curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json"       --data-binary @- "${API}/issues/${PR}/comments" >/dev/null
}

clear_review_status() {
  remove_label "review:ready"
  remove_label "review:running"
  remove_label "review:passed"
  remove_label "review:changes-requested"
  remove_label "review:failed"
}

ensure_all() {
  ensure_label "review:ready" "bfdadc" "Ready for automated Pi review"
  ensure_label "review:running" "fbca04" "Automated Pi review is running"
  ensure_label "review:passed" "0e8a16" "Automated Pi review passed"
  ensure_label "review:changes-requested" "d93f0b" "Automated Pi review found changes to make"
  ensure_label "review:failed" "b60205" "Automated Pi review workflow failed"
}

case "$ACTION" in
  ensure)
    ensure_all
    ;;
  running)
    ensure_all
    clear_review_status
    add_label "review:running"
    mark_commit pending "Automated review is running"
    comment
    ;;
  passed)
    ensure_all
    clear_review_status
    mark_commit success "Automated review and deterministic checks passed"
    add_label "review:passed"
    comment
    ;;
  changes-requested)
    ensure_all
    clear_review_status
    mark_commit failure "Automated review requested changes or checks failed"
    add_label "review:changes-requested"
    comment
    ;;
  stale)
    ensure_all
    clear_review_status
    mark_commit pending "Review base changed; waiting for refreshed branch"
    add_label "review:ready"
    ;;
  failed)
    ensure_all
    clear_review_status
    mark_commit error "Automated review workflow failed"
    add_label "review:failed"
    comment
    ;;
  *)
    echo "usage: $0 {ensure|running|passed|changes-requested|stale|failed} [comment]" >&2
    exit 2
    ;;
esac

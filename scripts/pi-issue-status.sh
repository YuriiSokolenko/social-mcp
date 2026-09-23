#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPO:?REPO is required}"
: "${ISSUE:?ISSUE is required}"

API="https://api.github.com/repos/${REPO}"
AUTH=(
  -H "Authorization: Bearer ${GH_TOKEN}"
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2022-11-28"
)

ensure_label() {
  local name="$1"
  local color="$2"
  local description="$3"
  local payload
  local response
  local code

  payload="$(jq -n     --arg name "$name"     --arg color "$color"     --arg description "$description"     '{name:$name,color:$color,description:$description}')"

  response="$(mktemp)"
  code="$(curl -sS -o "$response" -w '%{http_code}'     -X POST "${AUTH[@]}"     -H "Content-Type: application/json"     --data-binary "$payload"     "${API}/labels")"

  if [[ "$code" != "201" && "$code" != "422" ]]; then
    cat "$response" >&2
    rm -f "$response"
    return 1
  fi

  rm -f "$response"
}

remove_label() {
  local encoded="$1"
  curl -fsS -X DELETE "${AUTH[@]}"     "${API}/issues/${ISSUE}/labels/${encoded}" >/dev/null 2>&1 || true
}

add_label() {
  local name="$1"
  jq -n --arg name "$name" '{labels:[$name]}' |     curl -fsS -X POST "${AUTH[@]}"       -H "Content-Type: application/json"       --data-binary @-       "${API}/issues/${ISSUE}/labels" >/dev/null
}

comment() {
  local body="$1"
  jq -n --arg body "$body" '{body:$body}' |     curl -fsS -X POST "${AUTH[@]}"       -H "Content-Type: application/json"       --data-binary @-       "${API}/issues/${ISSUE}/comments" >/dev/null
}

clear_states() {
  remove_label "pi%3Aready"
  remove_label "pi%3Arunning"
  remove_label "pi%3Amr-created"
  remove_label "pi%3Aneeds-human"
  remove_label "pi%3Afailed"
  remove_label "pi%3Acancelled"
}

case "${1:-}" in
  ensure)
    ensure_label "pi:ready" "57f678" "Ready for the Pi issue agent"
    ensure_label "pi:running" "0052cc" "Pi agent is working on this issue"
    ensure_label "pi:mr-created" "1d76db" "Pi agent created a pull request"
    ensure_label "pi:needs-human" "fbca04" "Pi finished without a usable repository change"
    ensure_label "pi:failed" "d73a4a" "Pi agent workflow failed"
    ensure_label "pi:cancelled" "6e7781" "Pi agent workflow was cancelled"
    ;;
  running)
    clear_states
    add_label "pi:running"
    ;;
  mr-created)
    clear_states
    add_label "pi:mr-created"
    comment "${2:?comment text is required}"
    ;;
  needs-human)
    clear_states
    add_label "pi:needs-human"
    comment "${2:?comment text is required}"
    ;;
  failed)
    clear_states
    add_label "pi:failed"
    comment "${2:?comment text is required}"
    ;;
  cancelled)
    clear_states
    add_label "pi:cancelled"
    comment "${2:?comment text is required}"
    ;;
  *)
    echo "Usage: $0 {ensure|running|mr-created|needs-human|failed|cancelled} [comment]" >&2
    exit 2
    ;;
esac

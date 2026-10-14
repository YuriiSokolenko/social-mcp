#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_REPOSITORY:?}"
: "${RUNNER_TOKEN:?}"
: "${RUNNER_NAME:?}"
[ "$GITHUB_REPOSITORY" = YuriiSokolenko/recursive-coder ] || { echo 'Wrong repository' >&2; exit 1; }
[ "${RUNNER_LABELS:-}" = n150,recursive-coder-ci ] || { echo 'Wrong pool labels' >&2; exit 1; }
/usr/local/bin/recursive-coder-probe
# The runner supports input environment variables; never put tokens in argv.
export ACTIONS_RUNNER_INPUT_TOKEN="$RUNNER_TOKEN"
unset RUNNER_TOKEN GH_ADMIN_TOKEN
./config.sh --url "https://github.com/$GITHUB_REPOSITORY" --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABELS" --work _work --ephemeral --unattended --disableupdate
unset ACTIONS_RUNNER_INPUT_TOKEN
exec ./run.sh

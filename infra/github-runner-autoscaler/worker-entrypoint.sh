#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"

# Pi needs writable state for lock files and refreshed auth/model metadata.
# Seed a private copy from the host-mounted read-only configuration.
if [ -d /pi-config-ro ]; then
  rm -rf /home/runner/.pi/agent
  mkdir -p /home/runner/.pi/agent
  cp -a /pi-config-ro/. /home/runner/.pi/agent/
fi

cd /home/runner/actions-runner

./config.sh \
  --url "https://github.com/${GITHUB_REPOSITORY}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "n150,pi-agent" \
  --work "_work" \
  --ephemeral \
  --unattended \
  --disableupdate

exec ./run.sh

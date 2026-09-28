#!/usr/bin/env bash
# Forced-command target for the "Pi Model Switch" GitHub Actions workflow.
# The canonical copy of this file lives on nano at
# /home/yurasik/infra/llama-gguf-experimental/switch-model.sh -- this copy
# is kept in the repo for review/history; it is not executed from here.
#
# It is installed as the forced `command=` for a dedicated SSH key in
# nano's authorized_keys (see docs/pi-model-switch-setup.md). sshd puts
# whatever the client asked to run into $SSH_ORIGINAL_COMMAND and ignores
# it as an actual command -- this script runs instead, no matter what the
# client sent. We read that string ourselves and only accept an exact
# "laguna" or "qwen", nothing else. This makes the key genuinely scoped:
# even if it leaked, the worst it can do is switch which GGUF is loaded on
# this port, not run arbitrary commands.

set -euo pipefail

ROOT=/home/yurasik/infra/llama-gguf-experimental
REQUESTED="${SSH_ORIGINAL_COMMAND:-}"

case "$REQUESTED" in
  laguna)
    STOP_OTHER="$ROOT/stop_qwen38_flash_next_ud_q4_k_xl.sh"
    START_THIS="$ROOT/start_laguna_s_2_1_ud_q6_k_xl.sh"
    STATUS_THIS="$ROOT/status_laguna_s_2_1_ud_q6_k_xl.sh"
    ;;
  qwen)
    STOP_OTHER="$ROOT/stop_laguna_s_2_1_ud_q6_k_xl.sh"
    START_THIS="$ROOT/start_qwen38_flash_next_ud_q4_k_xl.sh"
    STATUS_THIS="$ROOT/status_qwen38_flash_next_ud_q4_k_xl.sh"
    ;;
  *)
    echo "ERROR: unrecognized model request: '${REQUESTED}' (expected exactly 'laguna' or 'qwen')" >&2
    exit 2
    ;;
esac

if "$STATUS_THIS" >/dev/null 2>&1; then
  echo "Requested model is already running -- nothing to do."
  exec "$STATUS_THIS"
fi

echo "Stopping the other model (no-op if it wasn't running)..."
"$STOP_OTHER"

echo "Starting requested model (this blocks until /v1/models is ready)..."
"$START_THIS"

echo
"$STATUS_THIS"

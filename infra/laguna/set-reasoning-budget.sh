#!/usr/bin/env bash
# Restart the Laguna llama-server on nano with a --reasoning-budget.
# Run ON nano:  ssh nano 'bash -s -- 3000' < infra/laguna/set-reasoning-budget.sh        (dry run)
#               ssh nano 'bash -s -- 3000 --apply' < infra/laguna/set-reasoning-budget.sh (restart)
# A restart kills in-flight generations, so --apply refuses while any slot is busy
# (add --force to override). The server is a bare nohup process: it does not come back
# after a host reboot, so this script only restarts what is already running.
set -euo pipefail

BUDGET="${1:-}"
APPLY=0; FORCE=0
for arg in "${@:2}"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[[ "$BUDGET" =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 <reasoning-budget-tokens> [--apply] [--force]" >&2; exit 2; }

ROOT="/home/yurasik/infra/llama-gguf-experimental"
PORT="${PORT:-3009}"

current="$(ps -o args= -C llama-server | tr ' ' '\n' | awk '/^--reasoning-budget$/{getline; print; exit}')"
echo "current --reasoning-budget: ${current:-<none, unrestricted>}"
echo "requested:                  $BUDGET"

busy="$(curl -fsS "http://127.0.0.1:${PORT}/slots" 2>/dev/null | python3 -c 'import json,sys; print(sum(1 for s in json.load(sys.stdin) if s.get("is_processing")))' 2>/dev/null || echo unknown)"
echo "busy slots:                 $busy"

if [[ "$APPLY" -ne 1 ]]; then
  echo "dry run: would run stop_laguna_s_2_1_ud_q6_k_xl.sh then REASONING_BUDGET=$BUDGET start_laguna_s_2_1_ud_q6_k_xl.sh"
  exit 0
fi
if [[ "$busy" != "0" && "$FORCE" -ne 1 ]]; then
  echo "refusing to restart: slots busy or unknown (use --force to override)" >&2
  exit 1
fi

cd "$ROOT"
./stop_laguna_s_2_1_ud_q6_k_xl.sh
REASONING_BUDGET="$BUDGET" ./start_laguna_s_2_1_ud_q6_k_xl.sh
ps -o args= -C llama-server | tr ' ' '\n' | awk '/^--reasoning-budget$/{getline; print "now running with --reasoning-budget " $0}'

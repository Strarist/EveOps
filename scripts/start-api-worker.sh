#!/usr/bin/env bash
set -euo pipefail

export EXPORT_DIR="${EXPORT_DIR:-$PWD/exports}"
mkdir -p "$EXPORT_DIR"

node apps/api/dist/main.js &
API_PID=$!
node apps/worker/dist/main.js &
WORKER_PID=$!

cleanup() {
  kill "$API_PID" "$WORKER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Exit if either process dies so Render restarts the service.
wait -n
exit_code=$?
cleanup
exit "$exit_code"

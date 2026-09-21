#!/usr/bin/env bash
set -euo pipefail

export EXPORT_DIR="${EXPORT_DIR:-$PWD/exports}"
mkdir -p "$EXPORT_DIR"

# Keep schema current. Default ALLOW_DEMO_SEED=true so pilot deploys keep the
# documented demo logins working; set ALLOW_DEMO_SEED=false to disable.
npx prisma migrate deploy
ALLOW_DEMO_SEED="${ALLOW_DEMO_SEED:-true}" npm run db:seed

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

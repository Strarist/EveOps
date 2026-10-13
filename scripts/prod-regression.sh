#!/usr/bin/env bash
# Production-mode EveOps lab on localhost eveops_regression.
# Does not read the application database from .env and does not send external pushes.
set -euo pipefail
cd "$(dirname "$0")/.."

umask 077
mkdir -p .local/phase4 test-results/phase4
chmod 700 .local .local/phase4

secret_file=".local/regression-fixture-password"
if [[ -z "${REGRESSION_FIXTURE_PASSWORD:-}" && -f "$secret_file" ]]; then
  REGRESSION_FIXTURE_PASSWORD="$(<"$secret_file")"
  export REGRESSION_FIXTURE_PASSWORD
fi
if [[ -z "${REGRESSION_FIXTURE_PASSWORD:-}" ]]; then
  REGRESSION_FIXTURE_PASSWORD="$(python3 -c 'import secrets; print(secrets.randbelow(9000000) + 1000000)')"
  export REGRESSION_FIXTURE_PASSWORD
  printf '%s' "$REGRESSION_FIXTURE_PASSWORD" > "$secret_file"
  chmod 600 "$secret_file"
fi
if [[ ! "$REGRESSION_FIXTURE_PASSWORD" =~ ^[0-9]{4,7}$ ]]; then
  echo "REGRESSION_FIXTURE_PASSWORD must be 4 to 7 digits." >&2
  exit 1
fi

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    case "$key" in
      SESSION_SECRET|OTP_ENCRYPTION_SECRET)
        if [[ -z "${!key:-}" ]]; then
          value="${line#*=}"
          value="${value%\"}"
          value="${value#\"}"
          value="${value%\'}"
          value="${value#\'}"
          export "$key=$value"
        fi
        ;;
    esac
  done < .env
fi

unset VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT || true

pick_port() {
  local port="$1"
  local limit=$((port + 20))
  while (( port <= limit )); do
    if ! lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$port"
      return
    fi
    port=$((port + 1))
  done
  echo "No free port near $1. Unrelated listeners were left running." >&2
  exit 1
}

web_port="${REGRESSION_WEB_PORT:-$(pick_port 3100)}"
api_port="${REGRESSION_API_PORT:-$(pick_port 4100)}"
if lsof -nP -iTCP:"${web_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${web_port} is already in use." >&2
  exit 1
fi
if lsof -nP -iTCP:"${api_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${api_port} is already in use." >&2
  exit 1
fi

export DATABASE_URL="postgresql://eveops:eveops@localhost:55432/eveops_regression?schema=public"
export ALLOW_DEMO_SEED=false
export EVEOPS_REQUIRE_DATABASE=eveops_regression
export PORT="$api_port"
export API_URL="http://127.0.0.1:${api_port}/api"
export NEXT_PUBLIC_API_URL="$API_URL"
export WEB_ORIGIN="http://127.0.0.1:${web_port}"
export E2E_BASE_URL="$WEB_ORIGIN"
export COOKIE_SECURE=false
export NEXT_DIST_DIR=".next-regression"
export BUILD_SHA="${BUILD_SHA:-$(git rev-parse HEAD)}"
export EVEOPS_PUSH_TRANSPORT=capture
export EVEOPS_PUSH_CAPTURE_LOG="$(pwd)/.local/phase4/push-capture.jsonl"
export REGRESSION_WEB_PORT="$web_port"
export REGRESSION_API_PORT="$api_port"

node scripts/assert-regression-database.mjs
npx prisma migrate deploy
npm run db:fixture:regression

if [[ "${REGRESSION_SKIP_BUILD:-}" != "1" ]]; then
  env -u NODE_ENV npm run build
fi

export NODE_ENV=production

api_pid=""
worker_pid=""
web_pid=""
worker_held=0

start_api() {
  npm run start -w @eveops/api > .local/phase4/api.log 2>&1 &
  api_pid=$!
  echo "$api_pid" > .local/phase4/api.pid
}
start_worker() {
  npm run start -w @eveops/worker > .local/phase4/worker.log 2>&1 &
  worker_pid=$!
  echo "$worker_pid" > .local/phase4/worker.pid
}
start_web() {
  npm run start -w @eveops/web -- --hostname 127.0.0.1 --port "$web_port" > .local/phase4/web.log 2>&1 &
  web_pid=$!
  echo "$web_pid" > .local/phase4/web.pid
}

cleanup() {
  local pid
  for pid in "$api_pid" "$worker_pid" "$web_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

start_api
start_worker
start_web

wait_http() {
  local url="$1"
  local attempts="${2:-90}"
  local i
  for (( i = 0; i < attempts; i++ )); do
    if curl -sf "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

wait_http "http://127.0.0.1:${api_port}/api/system/health" 90
wait_http "http://127.0.0.1:${web_port}/login" 90
ready_code="$(curl -s -o .local/phase4/ready.json -w '%{http_code}' "http://127.0.0.1:${api_port}/api/system/ready" || true)"
for (( i = 0; i < 30 && ready_code != 200; i++ )); do
  sleep 1
  ready_code="$(curl -s -o .local/phase4/ready.json -w '%{http_code}' "http://127.0.0.1:${api_port}/api/system/ready" || true)"
done
curl -sf "http://127.0.0.1:${api_port}/api/system/health" > .local/phase4/health.json
export READY_CODE="$ready_code"
export WORKER_NODE_PID="$(pgrep -P "$worker_pid" node | head -n 1 || true)"
export WEB_NODE_PID="$(pgrep -P "$web_pid" | while read -r child; do if ps -p "$child" -o command= | grep -q 'next'; then echo "$child"; break; fi; done)"

node --input-type=module <<'EOF'
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const health = JSON.parse(readFileSync('.local/phase4/health.json', 'utf8'));
const readyRaw = readFileSync('.local/phase4/ready.json', 'utf8');
let ready = null;
try { ready = JSON.parse(readyRaw); } catch { ready = { raw: readyRaw.slice(0, 500) }; }
const mem = Number(execSync('sysctl -n hw.memsize', { encoding: 'utf8' }).trim());
const cpus = Number(execSync('sysctl -n hw.ncpu', { encoding: 'utf8' }).trim());
writeFileSync('.local/phase4/lab.json', JSON.stringify({
  sha: process.env.BUILD_SHA,
  branch: execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
  status: execSync('git status --porcelain', { encoding: 'utf8' }),
  node: process.version,
  webPort: Number(process.env.REGRESSION_WEB_PORT),
  apiPort: Number(process.env.REGRESSION_API_PORT),
  webOrigin: process.env.WEB_ORIGIN,
  apiUrl: process.env.API_URL,
  databaseUrlTarget: 'postgresql://eveops@localhost:55432/eveops_regression',
  health,
  readyHttpStatus: Number(process.env.READY_CODE ?? 0),
  ready,
  pushTransport: 'capture',
  pushDelivery: 'simulated',
  nodeEnv: 'production',
  commands: {
    api: 'npm run start -w @eveops/api',
    worker: 'npm run start -w @eveops/worker',
    web: `npm run start -w @eveops/web -- --hostname 127.0.0.1 --port ${process.env.REGRESSION_WEB_PORT}`,
  },
  pids: {
    api: health.processId,
    worker: Number(process.env.WORKER_NODE_PID ?? 0),
    web: Number(process.env.WEB_NODE_PID ?? 0),
    apiNpm: Number(readFileSync('.local/phase4/api.pid', 'utf8')),
    workerNpm: Number(readFileSync('.local/phase4/worker.pid', 'utf8')),
    webNpm: Number(readFileSync('.local/phase4/web.pid', 'utf8')),
  },
  machine: { logicalCpus: cpus, memoryBytes: mem },
}, null, 2));
EOF

echo "Regression lab ready at ${WEB_ORIGIN} (API ${API_URL}). Push delivery is simulated."

while true; do
  if [[ -f .local/phase4/worker.stop ]]; then
    rm -f .local/phase4/worker.stop .local/phase4/worker.stopped
    worker_held=1
    if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
      kill "$worker_pid" 2>/dev/null || true
      wait "$worker_pid" 2>/dev/null || true
    fi
    worker_pid=""
    echo stopped > .local/phase4/worker.stopped
  fi
  if [[ -f .local/phase4/worker.start ]]; then
    rm -f .local/phase4/worker.start .local/phase4/worker.started
    start_worker
    worker_held=0
    echo started > .local/phase4/worker.started
  fi
  if [[ -f .local/phase4/restart.request ]]; then
    rm -f .local/phase4/restart.request .local/phase4/restart.done
    if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
      kill "$api_pid" 2>/dev/null || true
      wait "$api_pid" 2>/dev/null || true
    fi
    if [[ "$worker_held" -eq 0 && -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
      kill "$worker_pid" 2>/dev/null || true
      wait "$worker_pid" 2>/dev/null || true
    fi
    start_api
    if [[ "$worker_held" -eq 0 ]]; then
      start_worker
    fi
    wait_http "http://127.0.0.1:${api_port}/api/system/health" 60
    echo restarted > .local/phase4/restart.done
  fi
  if ! kill -0 "$web_pid" 2>/dev/null; then
    echo "Web process exited." >&2
    exit 1
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "API process exited." >&2
    exit 1
  fi
  if [[ "$worker_held" -eq 0 ]] && ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "Worker process exited." >&2
    exit 1
  fi
  sleep 1
done

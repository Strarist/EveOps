#!/usr/bin/env bash
# Isolated EveOps regression stack. Never selects the application database from .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${REGRESSION_FIXTURE_PASSWORD:-}" ]]; then
  echo "Set REGRESSION_FIXTURE_PASSWORD in the environment. Do not commit it." >&2
  exit 1
fi

# Take only non-database secrets from .env when the shell has not set them.
if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    case "$key" in
      SESSION_SECRET|OTP_ENCRYPTION_SECRET|VAPID_PUBLIC_KEY|VAPID_PRIVATE_KEY|VAPID_SUBJECT)
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

web_port="${REGRESSION_WEB_PORT:-3100}"
api_port="${REGRESSION_API_PORT:-4100}"

export DATABASE_URL="postgresql://eveops:eveops@localhost:55432/eveops_regression?schema=public"
export ALLOW_DEMO_SEED=false
export EVEOPS_REQUIRE_DATABASE=eveops_regression
export PORT="$api_port"
export API_URL="http://localhost:${api_port}/api"
export NEXT_PUBLIC_API_URL="$API_URL"
export WEB_ORIGIN="http://localhost:${web_port}"
export E2E_BASE_URL="$WEB_ORIGIN"
export COOKIE_SECURE=false
export NODE_ENV=development
export NEXT_DIST_DIR=".next-regression"

if command -v lsof >/dev/null && lsof -nP -iTCP:"${web_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${web_port} is already in use. Stop that regression web server or set REGRESSION_WEB_PORT. Unrelated services were left running." >&2
  exit 1
fi
if command -v lsof >/dev/null && lsof -nP -iTCP:"${api_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${api_port} is already in use. Stop that regression API or set REGRESSION_API_PORT. Unrelated services were left running." >&2
  exit 1
fi
node scripts/assert-regression-database.mjs
npx prisma migrate deploy
npm run db:fixture:regression

exec npx concurrently -n web,api,worker \
  "npm run dev -w @eveops/web -- --port ${web_port}" \
  "npm run start:dev -w @eveops/api" \
  "npm run start:dev -w @eveops/worker"

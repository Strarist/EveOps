#!/usr/bin/env bash
set -euo pipefail

npx prisma migrate deploy
ALLOW_DEMO_SEED="${ALLOW_DEMO_SEED:-true}" npm run db:seed

#!/usr/bin/env bash
set -euo pipefail

npx prisma migrate deploy
npm run db:seed

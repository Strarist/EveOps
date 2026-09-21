# EveOps

Exhibition operations and stall service management MVP. See `docs/deep-runtime-audit.md` for the current readiness evidence.

## Stack
- Next.js role-based PWA
- NestJS modular API with REST and SSE
- PostgreSQL via Prisma
- Background worker for timers/outbox
- Redis-ready local infrastructure

## Quick start
1. Copy .env.example to .env.
2. Run docker compose up -d.
3. Run npm install.
4. Run `npx prisma migrate deploy` and `npm run db:seed`.
5. Run npm run dev.

Open http://localhost:3000. API is served at http://localhost:4000/api.

## Protected role addresses
- Stall: `/stall`
- Service staff: `/staff`
- Hall Manager: `/hall-manager`
- Admin: `/admin`
- SuperAdmin: separately issued governance entry point; intentionally absent from operational navigation and documentation shown to event users

Every address requires authentication and an exact role match. Admin navigation does not expose SuperAdmin, and an Admin session cannot enter the governance workspace.
One browser profile has one host-wide EveOps session; use isolated browser contexts for simultaneous role verification.

Demo users are `stall@eveops.test`, `staff@eveops.test`, `house.staff@eveops.test`, `manager@eveops.test`, `admin@eveops.test`, and `super@eveops.test`; development password: `EveOpsDemo!2026`.

## Authoritative specifications
Read `01-product-plan.md`, `02-workflow.md`, `03-ui-ux-spec.md`, and `04-rules-permissions.md` in that order before changing architecture, data models, workflows, or permissions.

## Security and operational notes
- Replace all development credentials and SESSION_SECRET before deployment.
- Set an absolute `API_URL`, the public `WEB_ORIGIN`, and `COOKIE_SECURE=true` for HTTPS deployments. Plain HTTP requires `COOKIE_SECURE=false`; it is not an acceptable production transport.
- Demo seeding: Render start/predeploy default to `ALLOW_DEMO_SEED=true` so the documented demo accounts stay usable on pilot deploys. Set `ALLOW_DEMO_SEED=false` to skip. Locally, `npm run db:seed` always upserts demo users.
- PostgreSQL is authoritative; Redis must never become the system of record.
- OTP verification uses a one-way hash; the stall-only presentation value is encrypted at rest with AES-256-GCM and omitted from logs/exports.
- All protected endpoints enforce role and object scope server-side.
- State transitions and their audit events are committed atomically.
- Ticket writes emit durable outbox events. The worker claims them with database locks and PostgreSQL `LISTEN/NOTIFY` accelerates scoped SSE refresh; REST remains authoritative.
- Every API response includes `x-correlation-id`; callers may supply a valid correlation ID for cross-service tracing.

## Verification and operations
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, and `npm run build` are release gates.
- `npx prisma migrate deploy` applies database invariants. `npm run migration:preflight` checks applied checksums and the explicitly documented historical reconciliation.
- `GET /api/system/health` is the process liveness check. `GET /api/system/ready` includes build/process identity, database state, worker heartbeat age, retryable/dead-letter outbox counts, and failed exports.
- `npm run debug:ticket -- EV-00006` prints a redacted end-to-end ticket trace for development diagnostics.
- `npm run test:load` exercises authenticated ticket, management, workforce, governance, and SSE paths. Configure `LOAD_BASE_URL`, `LOAD_DURATION_MS`, `LOAD_CONCURRENCY`, and `LOAD_P95_LIMIT_MS`. Set `MUTATING_LOAD=true` only on disposable test data to include ticket creation and export generation.
- `npm run test:load:http` retains the single-path HTTP probe for targeted endpoint measurements.
- Export files expire after 24 hours and are removed by the worker. OTP plaintext is never included in exports.

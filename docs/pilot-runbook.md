# EveOps pilot runbook

## Required production secrets
- `SESSION_SECRET` (≥32 chars, no placeholders)
- `OTP_ENCRYPTION_SECRET` (≥32 chars, **must differ** from `SESSION_SECRET`)
- `DATABASE_URL`, `API_URL`
- Production cookies: `COOKIE_SECURE=true` behind HTTPS; local may use `false`

Missing/invalid secrets fail API startup in production.

## Deployment order
1. Validate environment secrets and connectivity
2. Confirm database reachable
3. `npm run db:generate`
4. `npm run db:deploy` (`prisma migrate deploy`) — **do not start the app if this fails**
5. For a fresh pilot database, run `npm run db:seed` (or set `ALLOW_DEMO_SEED=true` on Render so deploys re-upsert demo users). Empty production DBs also bootstrap demo users once on API start.
6. `npm run build:packages` then full `npm run build` (contracts → operations → api → worker → web)
7. `npm run verify:operations-fresh` (guards against stale `@eveops/operations` dist)
8. Start API
9. Start workers
10. Confirm `/api/system/health` (liveness) and `/api/system/ready` (readiness; **503 when degraded**)
11. Start / expose frontend traffic

## Staff approval vs account vs password
Keep these axes independent:

| Axis | Values | Meaning |
|---|---|---|
| Approval | `PENDING_APPROVAL` / `APPROVED` / `REJECTED` | Admin review of Hall Manager staff requests |
| Account | `ACTIVE` / `DISABLED` | Login eligibility |
| Availability | `ON_DUTY` / `PAUSED` / `OFF_DUTY` | Routing eligibility |
| Password | `mustChangePassword` | Temporary credential must be rotated before operations |

Created staff/admin accounts receive temporary passwords with `mustChangePassword=true`. First login redirects to `/change-password`. Operational APIs return 403 until rotation succeeds.

## Health vs readiness
- `GET /api/system/health` — process alive (cheap)
- `GET /api/system/ready` — database connected, worker heartbeat ≤30s, no dead-lettered outbox, no failed exports; returns **503** when degraded

## Before an event
1. Restore the latest production backup into staging and run the automated smoke suite.
2. Import and validate event, hall, zone, stall, service-pool, and user-scope masters.
3. Verify every service pool has on-duty staff and a Hall Manager.
4. Test Stall and Staff flows on representative Android, iPhone, and tablet browsers.
5. Confirm event timezone, response/resolution SLAs, OTP expiry, and emergency-close policy.
6. Verify `/api/system/ready`, database backups, and alert delivery.

## During an event
- Monitor API error rate, p95 latency, worker heartbeat, outbox backlog, queued tickets, response-overdue assignments, and failed exports.
- Hall Managers resolve reassignment, complaint, and repeated-reopen exceptions through audited UI actions.
- Admin emergency closure requires a reason; never alter audit or ticket records directly.
- If realtime disconnects, users continue through REST actions and reconnect/reconcile automatically.

## Stuck ticket recovery
1. Locate the ticket by public number (`npm run debug:ticket` or management ticket detail).
2. Inspect audit timeline, assignment cycles, and OTP challenge metadata (never plaintext).
3. Check worker and API logs using the correlation ID (`x-correlation-id` / JSON body `correlationId`).
4. Use reasoned reassignment, reopen, or emergency close only when permitted.
5. Do not edit PostgreSQL records manually.

## Backup and restore
- Enable daily managed PostgreSQL backups and point-in-time recovery through the cloud provider.
- Before a live event, perform a test restore into an **isolated** database and run `npm run db:deploy`.
- Confirm application can read restored masters, tickets, and workforce rows.
- Blob/CSV exports are disposable; authoritative data is reconstructed from PostgreSQL.
- Keep secrets in a vault and rotate them after any suspected exposure.

## Event closure
1. Export unresolved tickets and require an explicit Admin disposition; never auto-close them.
2. Generate final operational CSV reports and verify row counts/filter snapshots.
3. Retain data and generated exports according to organization policy.
4. Review response overdue, SLA breaches, reopen rate, complaint rate, and staff throughput.

## Known MVP limitations
- Reports are operational metrics + CSV exports, not full enterprise BI.
- Venue-scale load and production HTTPS reverse-proxy drills remain environment-specific.
- External SMS/WhatsApp delivery is out of MVP scope.

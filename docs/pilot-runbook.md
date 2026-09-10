# EveOps pilot runbook

## Before an event
1. Restore the latest production backup into staging and run the automated smoke suite.
2. Import and validate event, hall, zone, stall, service-pool, and user-scope masters.
3. Verify every service pool has on-duty staff and a Hall Manager.
4. Test Stall and Staff flows on representative Android, iPhone, and tablet browsers.
5. Confirm event timezone, response/resolution SLAs, OTP expiry, and emergency-close policy.
6. Verify `/api/system/ready`, database backups, Redis health, Blob access, and alert delivery.

## During an event
- Monitor API error rate, p95 latency, worker heartbeat, outbox backlog, queued tickets, response-overdue assignments, and failed exports.
- Hall Managers resolve reassignment, complaint, and repeated-reopen exceptions through audited UI actions.
- Admin emergency closure requires a reason; never alter audit or ticket records directly.
- If realtime disconnects, users continue through REST actions and reconnect/reconcile automatically.

## Stuck ticket recovery
1. Locate the ticket by public number and inspect its audit and assignment cycles.
2. Check worker and API logs using the correlation ID from the latest event.
3. Use a reasoned reassignment, reopen, or emergency close only when permitted.
4. Do not edit PostgreSQL records manually. Record any product defect separately.

## Backup and restore
- Enable daily managed PostgreSQL backups and point-in-time recovery through the cloud provider.
- Before a live event, perform a test restore into an isolated database and run `prisma migrate deploy`.
- Blob exports are disposable; authoritative data is reconstructed from PostgreSQL.
- Keep secrets in Azure Key Vault and rotate them after any suspected exposure.

## Event closure
1. Export unresolved tickets and require an explicit Admin disposition; never auto-close them.
2. Generate final operational CSV/XLSX reports and verify row counts/filter snapshots.
3. Retain data and generated exports according to organization policy.
4. Review response overdue, SLA breaches, reopen rate, complaint rate, and staff throughput.

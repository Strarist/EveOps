import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { accounts, call, login } from './phase4-accounts.mjs';

function marker(name) {
  writeFileSync(`.local/phase4/${name}`, '1');
}
async function waitFor(name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const { readFileSync } = await import('node:fs');
      readFileSync(`.local/phase4/${name}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for ${name}`);
}

const stall = accounts.find((account) => account.email === 'regression.stall.h1-04@volume.lab');
const cookie = await login(stall);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const before = await client.query(`SELECT count(*)::int AS n FROM "Assignment"`);
marker('worker.stop');
await waitFor('worker.stopped');
const created = await call(cookie, 'POST', '/tickets', {
  category: 'HOUSE_HELP',
  subtype: 'General',
  description: 'Phase 4 restart recovery',
  priority: 'NORMAL',
  idempotencyKey: randomUUID(),
});
if (created.status !== 201) throw new Error(`Restart ticket returned ${created.status}`);
const pending = await client.query(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "aggregateId" = $1 AND "processedAt" IS NULL`, [created.payload.id]);
marker('restart.request');
await waitFor('restart.done');
marker('worker.start');
await waitFor('worker.started');
let processed = 0;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const row = await client.query(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "aggregateId" = $1 AND "processedAt" IS NOT NULL`, [created.payload.id]);
  processed = row.rows[0].n;
  if (processed > 0) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const assignments = await client.query(`SELECT count(*)::int AS n FROM "Assignment" WHERE "ticketId" = $1`, [created.payload.id]);
const after = await client.query(`SELECT count(*)::int AS n FROM "Assignment"`);
await client.end();
const report = {
  ticketStatus: created.status,
  pendingWhileWorkerStopped: pending.rows[0].n,
  processedAfterRecovery: processed,
  assignmentsForRecoveredTicket: assignments.rows[0].n,
  assignmentRowsBefore: before.rows[0].n,
  assignmentRowsAfter: after.rows[0].n,
};
writeFileSync('.local/phase4/restart.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (pending.rows[0].n < 1 || processed < 1 || assignments.rows[0].n > 1) process.exitCode = 1;

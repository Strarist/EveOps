import { PrismaService } from './prisma.service';
import { seedHistoricalVolume, validateHistoricalVolume, walkAuditPages, HIST_VOLUME_ACTION } from './regression-history';

const total = Number(process.argv[2] ?? process.env.HIST_COUNT ?? '');
if (!Number.isInteger(total)) {
  console.error('Usage: tsx apps/api/src/regression-history.cli.ts <count>');
  process.exit(1);
}

async function main() {
  const prisma = new PrismaService();
  const started = Date.now();
  const seeded = await seedHistoricalVolume(prisma, total);
  const validated = await validateHistoricalVolume(prisma);
  const adminScope = {
    userId: 'regression-user-admin',
    role: 'ADMIN' as const,
    eventIds: ['regression-event'],
    hallIds: [],
    serviceTypes: [],
  };
  const noteWalk = await walkAuditPages(adminScope, { action: HIST_VOLUME_ACTION, limit: 100 });
  const [ticketEvents, managementAudits] = await Promise.all([
    prisma.ticketEvent.count({ where: { eventId: 'regression-event' } }),
    prisma.managementAudit.count({
      where: {
        OR: [
          { eventId: 'regression-event' },
          { eventId: null, organizationId: 'regression-org' },
        ],
      },
    }),
  ]);
  const fullWalk = await walkAuditPages(adminScope, { limit: 100 });
  await prisma.$disconnect();
  const report = {
    seeded,
    validated,
    noteWalk,
    fullWalk,
    expectedNoteRows: seeded.auditNotes,
    expectedFullRows: ticketEvents + managementAudits,
    elapsedMs: Date.now() - started,
    insert: 'direct historical rows tagged HIST- / hist-*, without outbox or OTP ciphertext',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!validated.ok || noteWalk.duplicate || noteWalk.rows !== seeded.auditNotes || fullWalk.duplicate || fullWalk.rows !== ticketEvents + managementAudits) {
    process.exitCode = 1;
  }
}

void main();

import { PrismaClient } from '@prisma/client';

const identifier = process.argv[2];
if (!identifier) {
  console.error('Usage: npm run debug:ticket -- EV-00006');
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const ticket = await prisma.ticket.findFirst({
    where: { OR: [{ id: identifier }, { publicNo: identifier }] },
    include: {
      event: { select: { id: true, name: true, timezone: true, status: true } },
      hall: { select: { id: true, code: true, name: true, active: true } },
      zone: { select: { id: true, code: true, active: true } },
      stall: { select: { id: true, stallCode: true, exhibitorName: true, active: true } },
      pool: { select: { id: true, category: true, subtype: true, hallId: true, active: true } },
      assignments: {
        orderBy: { assignedAt: 'asc' },
        include: { staff: { select: { id: true, name: true, email: true, role: true, status: true } } },
      },
      events: {
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { id: true, name: true, role: true } } },
      },
      complaints: {
        orderBy: { createdAt: 'asc' },
        include: { creator: { select: { id: true, name: true, role: true } } },
      },
      otpChallenges: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          attempts: true,
          invalidatedAt: true,
          verifiedAt: true,
          verifiedBy: true,
          activeTicketKey: true,
        },
      },
      notifications: {
        orderBy: { sentAt: 'asc' },
        select: { id: true, recipientId: true, type: true, readAt: true, sentAt: true, payload: true },
      },
    },
  });
  if (!ticket) throw new Error(`Ticket ${identifier} was not found`);

  const outbox = await prisma.outboxEvent.findMany({
    where: { aggregateType: 'Ticket', aggregateId: ticket.id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      eventType: true,
      createdAt: true,
      processedAt: true,
      attempts: true,
      lockedAt: true,
      lockOwner: true,
      lastError: true,
      payload: true,
    },
  });
  const roleScopes = await prisma.userScope.findMany({
    where: {
      eventId: ticket.eventId,
      OR: [
        { stallId: ticket.stallId, user: { role: 'STALL' } },
        { hallId: ticket.hallId, user: { role: 'HALL_MANAGER' } },
        { user: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } },
        { userId: { in: ticket.assignments.map((assignment) => assignment.staffId) } },
      ],
    },
    include: { user: { select: { id: true, name: true, email: true, role: true, status: true } } },
  });

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    ticket,
    authorizedRoleCandidates: roleScopes,
    outbox,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

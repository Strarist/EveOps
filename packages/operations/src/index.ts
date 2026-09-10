import { Prisma, PrismaClient, TicketStatus, type Ticket } from '@prisma/client';
import { randomUUID } from 'node:crypto';

type DatabaseClient = Pick<PrismaClient, '$transaction'>;

export type RoutingChange = { ticket: Ticket; assigneeId?: string };
export type RoutingResult = { requested: Ticket; changed: RoutingChange[] };

const transitionsToAssigned = new Set<TicketStatus>(['NEW', 'QUEUED', 'REOPENED']);

export async function routeTicket(database: DatabaseClient, ticketId: string, actorId?: string, correlationId: string = randomUUID()): Promise<RoutingResult> {
  return database.$transaction(async (tx) => {
    const initial = await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!initial.poolId) throw new Error('No compatible service pool');
    if (!transitionsToAssigned.has(initial.status)) return { requested: initial, changed: [] };

    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${initial.poolId}, 0))`);
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "Ticket"
      WHERE "poolId" = ${initial.poolId} AND status IN ('NEW', 'REOPENED', 'QUEUED')
      FOR UPDATE
    `);
    const requestedTicket = await tx.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    if (!transitionsToAssigned.has(requestedTicket.status)) return { requested: requestedTicket, changed: [] };
    const pool = await tx.servicePool.findUniqueOrThrow({ where: { id: requestedTicket.poolId! }, select: { category: true } });
    const eligibleRole = pool.category === 'HALL_MANAGER' ? 'HALL_MANAGER' : 'STAFF';

    const memberships = await tx.workforceMembership.findMany({
      where: {
        poolId: requestedTicket.poolId!,
        availability: 'ON_DUTY',
        user: { role: eligibleRole, status: 'ACTIVE' },
      },
      orderBy: [{ lastAvailableAt: 'asc' }, { userId: 'asc' }],
    });
    if (memberships.length) {
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM "User"
        WHERE id IN (${Prisma.join(memberships.map((membership) => membership.userId))})
        ORDER BY id
        FOR UPDATE
      `);
    }
    const loads = memberships.length
      ? await tx.assignment.groupBy({
          by: ['staffId'],
          where: {
            staffId: { in: memberships.map((membership) => membership.userId) },
            status: { in: ['ACTIVE', 'ACCEPTED'] },
          },
          _count: { _all: true },
        })
      : [];
    const loadByStaff = new Map(loads.map((load) => [load.staffId, load._count._all]));
    const selectedStaff = memberships
      .filter((membership) => (loadByStaff.get(membership.userId) ?? 0) < membership.capacity)
      .sort((left, right) =>
        (loadByStaff.get(left.userId) ?? 0) - (loadByStaff.get(right.userId) ?? 0) ||
        left.lastAvailableAt.getTime() - right.lastAvailableAt.getTime() ||
        left.userId.localeCompare(right.userId),
      )[0];
    const waiting = await tx.ticket.findFirst({
      where: { poolId: requestedTicket.poolId, status: 'QUEUED' },
      orderBy: [
        { queuePriorityOverrideAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
    const selectedTicket = selectedStaff ? waiting ?? requestedTicket : undefined;
    const now = new Date();
    const changed: RoutingChange[] = [];

    if ((!selectedStaff || selectedTicket?.id !== requestedTicket.id) && requestedTicket.status !== 'QUEUED') {
      const queued = await tx.ticket.update({
        where: { id: requestedTicket.id, version: requestedTicket.version },
        data: { status: 'QUEUED', queuedAt: now, version: { increment: 1 } },
      });
      await tx.ticketEvent.create({
        data: {
          eventId: queued.eventId,
          ticketId: queued.id,
          eventType: 'TICKET_QUEUED',
          actorId,
          fromStatus: requestedTicket.status,
          toStatus: 'QUEUED',
          correlationId,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: queued.eventId,
          aggregateType: 'Ticket',
          aggregateId: queued.id,
          eventType: 'TICKET_QUEUED',
          payload: eventPayload(queued),
        },
      });
      changed.push({ ticket: queued });
    }

    if (selectedStaff && selectedTicket) {
      await tx.assignment.create({
        data: {
          eventId: selectedTicket.eventId,
          ticketId: selectedTicket.id,
          staffId: selectedStaff.userId,
          activeTicketKey: selectedTicket.id,
        },
      });
      const stallRecipients = await tx.userScope.findMany({
        where: { eventId: selectedTicket.eventId, stallId: selectedTicket.stallId, user: { role: 'STALL' } },
        select: { userId: true },
      });
      const assignmentRecipients = [...new Set([selectedStaff.userId, ...stallRecipients.map((scope) => scope.userId)])];
      await tx.notification.createMany({
        data: assignmentRecipients.map((recipientId) => ({
          eventId: selectedTicket.eventId,
          recipientId,
          ticketId: selectedTicket.id,
          type: 'TICKET_ASSIGNED',
          dedupeKey: `ticket-assigned:${selectedTicket.id}:${recipientId}:${selectedTicket.version}`,
          payload: { hallId: selectedTicket.hallId },
        })),
        skipDuplicates: true,
      });
      const assigned = await tx.ticket.update({
        where: { id: selectedTicket.id, version: selectedTicket.version },
        data: {
          status: 'ASSIGNED',
          firstAssignedAt: selectedTicket.firstAssignedAt ?? now,
          queuePriorityOverrideAt: null,
          version: { increment: 1 },
        },
      });
      const wasQueued = selectedTicket.status === 'QUEUED';
      await tx.ticketEvent.create({
        data: {
          eventId: assigned.eventId,
          ticketId: assigned.id,
          eventType: wasQueued ? 'DEQUEUED_AND_ASSIGNED' : 'ASSIGNMENT_CREATED',
          actorId,
          fromStatus: selectedTicket.status,
          toStatus: 'ASSIGNED',
          correlationId,
          metadata: { staffId: selectedStaff.userId },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: assigned.eventId,
          aggregateType: 'Ticket',
          aggregateId: assigned.id,
          eventType: wasQueued ? 'DEQUEUED_AND_ASSIGNED' : 'ASSIGNMENT_CREATED',
          payload: { ...eventPayload(assigned), assigneeId: selectedStaff.userId },
        },
      });
      changed.push({ ticket: assigned, assigneeId: selectedStaff.userId });
    }

    return {
      requested: changed.find((change) => change.ticket.id === requestedTicket.id)?.ticket ?? requestedTicket,
      changed,
    };
  });
}

function eventPayload(ticket: Ticket) {
  return {
    ticketId: ticket.id,
    eventId: ticket.eventId,
    hallId: ticket.hallId,
    stallId: ticket.stallId,
    version: ticket.version,
  };
}

import type { Prisma, PrismaClient, ServicePriority, TicketStatus } from '@prisma/client';
import type { AuthScope } from '@eveops/contracts';
import { ManagementService } from './management';
import { PrismaService } from './prisma.service';
import { assertRegressionDatabase } from './regression-fixture';

/** Direct historical rows. They are not routed and do not create outbox work. */
export const HIST_PUBLIC_PREFIX = 'HIST-';
export const HIST_VOLUME_ACTION = 'HIST_VOLUME_NOTE';
const EVENT_ID = 'regression-event';
const ORG_ID = 'regression-org';
const ADMIN_ID = 'regression-user-admin';
const OPEN_SLOTS = 36;
const AUDIT_NOTES = 250;
const BASE_MS = Date.parse('2026-01-15T00:00:00.000Z');

type Kind = 'closed' | 'cancelled' | 'closed-complaint' | 'closed-reopened' | 'active' | 'queued' | 'reopened' | 'complaint-open';

type StallRow = {
  id: string;
  stallCode: string;
  servicePriority: ServicePriority;
  zoneId: string;
  hallId: string;
  hallCode: string;
  userId: string;
};

type StaffRow = { userId: string; hallId: string; category: string; availability: string };

function pad(index: number) {
  return String(index).padStart(7, '0');
}

function kindFor(index: number, total: number): Kind {
  const openStart = total - OPEN_SLOTS;
  if (index < openStart) {
    const bucket = index % 10;
    if (bucket === 0) return 'cancelled';
    if (bucket === 1) return 'closed-complaint';
    if (bucket === 2) return 'closed-reopened';
    return 'closed';
  }
  const openIndex = index - openStart;
  if (openIndex < 7) return 'active';
  if (openIndex < 19) return 'queued';
  if (openIndex < 27) return 'reopened';
  return 'complaint-open';
}

function statusFor(kind: Kind, activeSlot: number): TicketStatus {
  if (kind === 'cancelled') return 'CANCELLED';
  if (kind === 'queued') return 'QUEUED';
  if (kind === 'reopened') return 'REOPENED';
  if (kind === 'complaint-open') return 'COMPLAINT_RAISED';
  if (kind === 'closed' || kind === 'closed-complaint' || kind === 'closed-reopened') return 'CLOSED';
  if (activeSlot < 2) return 'ASSIGNED';
  if (activeSlot < 4) return 'ACCEPTED';
  return 'IN_PROGRESS';
}

/**
 * Replaces tagged historical rows in eveops_regression.
 * Inserts are direct: TicketService would enqueue live routing for every row.
 */
export async function seedHistoricalVolume(prisma: PrismaClient, total: number) {
  assertRegressionDatabase();
  if (!Number.isInteger(total) || total < OPEN_SLOTS) {
    throw new Error(`Historical volume must be an integer of at least ${OPEN_SLOTS}`);
  }
  const stalls = await loadStalls(prisma);
  const staff = await loadStaff(prisma);
  if (stalls.length < 18) throw new Error(`Expected 18 exhibitor stalls before historical seed, found ${stalls.length}`);
  const busy = new Set((await prisma.assignment.findMany({
    where: { status: { in: ['ACTIVE', 'ACCEPTED'] }, activeTicketKey: { not: null }, ticket: { publicNo: { not: { startsWith: HIST_PUBLIC_PREFIX } } } },
    select: { staffId: true },
  })).map((row) => row.staffId));
  const freeOnDuty: StaffRow[] = [];
  for (const person of staff) {
    if (person.availability !== 'ON_DUTY' || busy.has(person.userId)) continue;
    if (freeOnDuty.some((existing) => existing.userId === person.userId)) continue;
    freeOnDuty.push(person);
    if (freeOnDuty.length === 7) break;
  }

  await clearHistorical(prisma);

  const tickets: Prisma.TicketCreateManyInput[] = [];
  const events: Prisma.TicketEventCreateManyInput[] = [];
  const assignments: Prisma.AssignmentCreateManyInput[] = [];
  const complaints: Prisma.ComplaintCreateManyInput[] = [];
  const counts: Record<string, number> = {};
  let activeSlot = 0;

  async function flush() {
    if (tickets.length) await prisma.ticket.createMany({ data: tickets.splice(0) });
    if (assignments.length) await prisma.assignment.createMany({ data: assignments.splice(0) });
    if (events.length) await prisma.ticketEvent.createMany({ data: events.splice(0) });
    if (complaints.length) await prisma.complaint.createMany({ data: complaints.splice(0) });
  }

  for (let index = 1; index <= total; index += 1) {
    let kind = kindFor(index - 1, total);
    const rotated = stalls[(index - 1) % stalls.length];
    const electrical = index % 2 === 0;
    const category = electrical ? 'ELECTRICAL' : 'HOUSE_HELP';
    const subtype = electrical ? 'Lighting' : 'General';
    const at = new Date(BASE_MS + index * 60_000);
    const id = `hist-ticket-${pad(index)}`;
    const publicNo = `${HIST_PUBLIC_PREFIX}${pad(index)}`;
    const assignee = kind === 'active' ? freeOnDuty[activeSlot] : undefined;
    if (kind === 'active' && assignee) activeSlot += 1;
    if (kind === 'active' && !assignee) kind = 'queued';
    const home = assignee ? (stalls.find((item) => item.hallId === assignee.hallId) ?? rotated) : rotated;
    const poolId = `regression-pool-${home.hallCode.toLowerCase()}-${category.toLowerCase()}-${subtype.toLowerCase()}`;
    const status = statusFor(kind, kind === 'active' ? activeSlot - 1 : 0);
    const terminal = status === 'CLOSED' || status === 'CANCELLED';
    counts[kind] = (counts[kind] ?? 0) + 1;
    tickets.push({
      id,
      publicNo,
      eventId: EVENT_ID,
      hallId: home.hallId,
      zoneId: home.zoneId,
      stallId: home.id,
      poolId,
      category,
      subtype,
      description: `[historical] ${category.toLowerCase()} request ${index}`,
      priority: 'NORMAL',
      servicePriority: home.servicePriority,
      status,
      createdById: home.userId,
      idempotencyKey: `hist-${pad(index)}`,
      queuedAt: status === 'QUEUED' || status === 'REOPENED' ? at : null,
      firstAssignedAt: assignee || terminal ? at : null,
      firstAcceptedAt: status === 'ACCEPTED' || status === 'IN_PROGRESS' || status === 'CLOSED' ? at : null,
      firstStartedAt: status === 'IN_PROGRESS' || status === 'CLOSED' ? at : null,
      closedAt: status === 'CLOSED' ? at : null,
      reopenCount: kind === 'reopened' || kind === 'closed-reopened' ? 1 : 0,
      createdAt: at,
    });
    const event = (suffix: string, eventType: string, toStatus: TicketStatus | null, fromStatus?: TicketStatus) => {
      events.push({
        id: `hist-event-${pad(index)}-${suffix}`,
        eventId: EVENT_ID,
        ticketId: id,
        eventType,
        actorId: home.userId,
        fromStatus: fromStatus ?? null,
        toStatus,
        correlationId: `hist-${pad(index)}-${suffix}`,
        metadata: { source: 'historical-fixture' },
        createdAt: at,
      });
    };
    event('1', 'TICKET_CREATED', 'NEW');
    if (kind === 'cancelled') event('2', 'STATUS_CANCELLED', 'CANCELLED', 'NEW');
    if (kind === 'queued') event('2', 'STATUS_QUEUED', 'QUEUED', 'NEW');
    if (kind === 'complaint-open' || kind === 'closed-complaint') {
      event('2', 'COMPLAINT_RAISED', 'COMPLAINT_RAISED', 'CLOSED');
      complaints.push({
        id: `hist-cmp-${pad(index)}`,
        eventId: EVENT_ID,
        ticketId: id,
        reasonCode: 'WORK_QUALITY',
        comment: 'Historical complaint',
        createdBy: home.userId,
        idempotencyKey: `hist-cmp-${pad(index)}`,
        resolution: kind === 'closed-complaint' ? 'Historical resolution' : null,
        createdAt: at,
      });
    }
    if (kind === 'reopened' || kind === 'closed-reopened') event('2', 'STATUS_REOPENED', 'REOPENED', 'CLOSED');
    if (status === 'CLOSED') event('3', 'TICKET_CLOSED', 'CLOSED', 'AWAITING_OTP');
    if (assignee) {
      const assignmentStatus = status === 'ASSIGNED' ? 'ACTIVE' : 'ACCEPTED';
      assignments.push({
        id: `hist-asg-${pad(index)}`,
        eventId: EVENT_ID,
        ticketId: id,
        staffId: assignee.userId,
        status: assignmentStatus,
        activeTicketKey: id,
        assignedAt: at,
      });
      event('4', 'STATUS_ASSIGNED', 'ASSIGNED', 'QUEUED');
    } else if (terminal && status === 'CLOSED') {
      const closer = staff.find((person) => person.hallId === home.hallId && person.category === category) ?? staff[index % staff.length];
      if (closer) {
        assignments.push({
          id: `hist-asg-${pad(index)}`,
          eventId: EVENT_ID,
          ticketId: id,
          staffId: closer.userId,
          status: 'RELEASED',
          activeTicketKey: null,
          assignedAt: at,
          acceptedAt: at,
          startedAt: at,
          releasedAt: at,
          releaseReason: 'OTP verified',
        });
      }
    }
    if (tickets.length >= 400) await flush();
  }
  await flush();

  const audits: Prisma.ManagementAuditCreateManyInput[] = [];
  for (let index = 1; index <= AUDIT_NOTES; index += 1) {
    const stall = stalls[(index - 1) % stalls.length];
    audits.push({
      id: `hist-audit-${pad(index)}`,
      organizationId: ORG_ID,
      eventId: EVENT_ID,
      actorId: ADMIN_ID,
      targetUserId: stall.userId,
      action: HIST_VOLUME_ACTION,
      metadata: { source: 'historical-fixture', note: index },
      createdAt: new Date(BASE_MS + index * 60_000),
    });
  }
  await prisma.managementAudit.createMany({ data: audits });
  return { total, counts, auditNotes: AUDIT_NOTES, activeAssignees: freeOnDuty.length, openSlots: OPEN_SLOTS };
}

async function loadStalls(prisma: PrismaClient): Promise<StallRow[]> {
  const rows = await prisma.stall.findMany({
    where: { eventId: EVENT_ID, archivedAt: null, stallCode: { not: 'H4-VACANT' } },
    include: { zone: { select: { id: true, hallId: true, hall: { select: { code: true } } } } },
    orderBy: { stallCode: 'asc' },
  });
  const scopes = await prisma.userScope.findMany({
    where: { stallId: { in: rows.map((row) => row.id) }, user: { role: 'STALL' } },
    select: { stallId: true, userId: true },
  });
  const userByStall = new Map(scopes.map((scope) => [scope.stallId, scope.userId]));
  return rows.flatMap((row) => {
    const userId = userByStall.get(row.id);
    if (!userId) return [];
    return [{
      id: row.id,
      stallCode: row.stallCode,
      servicePriority: row.servicePriority,
      zoneId: row.zoneId,
      hallId: row.zone.hallId,
      hallCode: row.zone.hall.code,
      userId,
    }];
  });
}

async function loadStaff(prisma: PrismaClient): Promise<StaffRow[]> {
  const rows = await prisma.workforceMembership.findMany({
    where: { eventId: EVENT_ID, user: { role: 'STAFF' } },
    select: {
      userId: true,
      availability: true,
      pool: { select: { hallId: true, category: true } },
    },
  });
  return rows.flatMap((row) => row.pool.hallId ? [{
    userId: row.userId,
    hallId: row.pool.hallId,
    category: row.pool.category,
    availability: row.availability,
  }] : []);
}

async function clearHistorical(prisma: PrismaClient) {
  const ticket = { ticketId: { startsWith: 'hist-ticket-' } };
  await prisma.notification.deleteMany({ where: ticket });
  await prisma.otpChallenge.deleteMany({ where: ticket });
  await prisma.complaint.deleteMany({ where: ticket });
  await prisma.assignment.deleteMany({ where: ticket });
  await prisma.ticketEvent.deleteMany({ where: ticket });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { startsWith: 'hist-ticket-' } } });
  await prisma.ticket.deleteMany({ where: { id: { startsWith: 'hist-ticket-' } } });
  await prisma.managementAudit.deleteMany({ where: { id: { startsWith: 'hist-audit-' } } });
}

export async function validateHistoricalVolume(prisma: PrismaClient) {
  assertRegressionDatabase();
  const [statusRows, activePerTicket, activePerStaff, capacityRows, otpRows, outboxRows, missingEvents, missingEventId] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], where: { publicNo: { startsWith: HIST_PUBLIC_PREFIX } }, _count: { _all: true } }),
    prisma.assignment.groupBy({
      by: ['ticketId'],
      where: { status: { in: ['ACTIVE', 'ACCEPTED'] }, ticket: { publicNo: { startsWith: HIST_PUBLIC_PREFIX } } },
      _count: { _all: true },
    }),
    prisma.assignment.groupBy({
      by: ['staffId'],
      where: { status: { in: ['ACTIVE', 'ACCEPTED'] }, activeTicketKey: { not: null } },
      _count: { _all: true },
    }),
    prisma.workforceMembership.findMany({
      where: { eventId: EVENT_ID },
      select: { userId: true, capacity: true },
    }),
    prisma.otpChallenge.count({ where: { ticket: { publicNo: { startsWith: HIST_PUBLIC_PREFIX } } } }),
    prisma.outboxEvent.count({ where: { aggregateId: { startsWith: 'hist-ticket-' } } }),
    prisma.ticket.count({ where: { publicNo: { startsWith: HIST_PUBLIC_PREFIX }, events: { none: {} } } }),
    prisma.ticket.count({ where: { publicNo: { startsWith: HIST_PUBLIC_PREFIX }, eventId: { not: EVENT_ID } } }),
  ]);
  const capacityByUser = new Map<string, number>();
  for (const row of capacityRows) capacityByUser.set(row.userId, Math.max(capacityByUser.get(row.userId) ?? 0, row.capacity));
  const overCapacity = activePerStaff.filter((row) => row._count._all > (capacityByUser.get(row.staffId) ?? 1));
  const duplicateAssignees = activePerTicket.filter((row) => row._count._all > 1);
  return {
    byStatus: Object.fromEntries(statusRows.map((row) => [row.status, row._count._all])),
    historicalTickets: statusRows.reduce((sum, row) => sum + row._count._all, 0),
    simultaneouslyActiveHistorical: activePerTicket.length,
    duplicateActiveAssignees: duplicateAssignees.length,
    staffOverCapacity: overCapacity.length,
    historicalOtpRows: otpRows,
    historicalOutboxRows: outboxRows,
    ticketsWithoutEvents: missingEvents,
    ticketsOutsideEvent: missingEventId,
    ok: duplicateAssignees.length === 0 && overCapacity.length === 0 && otpRows === 0 && outboxRows === 0 && missingEvents === 0 && missingEventId === 0,
  };
}

export async function walkAuditPages(scope: AuthScope, query: { action?: string; ticket?: string; limit?: number }) {
  const prisma = new PrismaService();
  const management = new ManagementService(prisma);
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let duplicate = false;
  do {
    const page = await management.audit(scope, { ...query, cursor, limit: query.limit ?? 100 });
    pages += 1;
    for (const item of page.items) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) duplicate = true;
      seen.add(key);
    }
    cursor = page.nextCursor ?? undefined;
    if (pages > 10000) throw new Error('Audit walk did not terminate');
  } while (cursor);
  await prisma.$disconnect();
  return { pages, rows: seen.size, duplicate };
}

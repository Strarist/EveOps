import type { Prisma } from '@prisma/client';
import { alertTone, assignmentSummary, exhibitorSummary, isHallBroadcast, serviceCategoryLabel, teamBroadcastSummary, type AlertAudience } from './alert-audience';

type TicketRef = {
  id: string;
  eventId: string;
  hallId: string;
  stallId: string;
  version: number;
  category: string;
  publicNo?: string | null;
};

const FIELD_SERVICES = ['ELECTRICAL', 'HOUSE_HELP'] as const;

export async function fanOutTicketAlerts(
  tx: Prisma.TransactionClient,
  input: {
    type: string;
    ticket: TicketRef;
    actorId?: string | null;
    eventToken: string;
    mode: 'broadcast' | 'assignment' | 'lifecycle';
    assigneeId?: string | null;
  },
) {
  const stall = await tx.stall.findUnique({ where: { id: input.ticket.stallId }, select: { stallCode: true } });
  const stallCode = stall?.stallCode ?? 'stall';
  const assignment = input.assigneeId
    ? { staffId: input.assigneeId }
    : await tx.assignment.findFirst({
      where: { ticketId: input.ticket.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
      orderBy: { assignedAt: 'desc' },
      select: { staffId: true },
    });
  const managers = await tx.userScope.findMany({
    where: {
      eventId: input.ticket.eventId,
      hallId: input.ticket.hallId,
      user: { role: 'HALL_MANAGER', status: 'ACTIVE', approvalStatus: 'APPROVED' },
    },
    select: { userId: true },
  });
  const stalls = await tx.userScope.findMany({
    where: {
      eventId: input.ticket.eventId,
      stallId: input.ticket.stallId,
      user: { role: 'STALL', status: 'ACTIVE', approvalStatus: 'APPROVED' },
    },
    select: { userId: true },
  });
  const recipients = new Map<string, AlertAudience>();
  for (const row of stalls) recipients.set(row.userId, 'stall');
  for (const row of managers) recipients.set(row.userId, 'manager');

  if (input.mode === 'broadcast') {
    const onDuty = await tx.workforceMembership.findMany({
      where: {
        eventId: input.ticket.eventId,
        availability: 'ON_DUTY',
        pool: { hallId: input.ticket.hallId, active: true, category: { in: [...FIELD_SERVICES] } },
        user: {
          role: 'STAFF',
          status: 'ACTIVE',
          approvalStatus: 'APPROVED',
          scopes: {
            some: {
              eventId: input.ticket.eventId,
              hallId: input.ticket.hallId,
              serviceType: { in: [...FIELD_SERVICES] },
            },
          },
        },
      },
      select: { userId: true },
    });
    for (const row of onDuty) {
      if (!recipients.has(row.userId)) recipients.set(row.userId, 'team');
    }
    if (assignment) {
      const paused = await tx.workforceMembership.findFirst({
        where: {
          userId: assignment.staffId,
          eventId: input.ticket.eventId,
          availability: 'PAUSED',
          pool: { hallId: input.ticket.hallId, category: { in: [...FIELD_SERVICES] } },
          user: { role: 'STAFF', status: 'ACTIVE', approvalStatus: 'APPROVED' },
        },
        select: { userId: true },
      });
      if (paused && !recipients.has(paused.userId)) recipients.set(paused.userId, 'own');
    }
  } else if (input.mode === 'assignment' && assignment) {
    const assignee = await tx.user.findFirst({
      where: { id: assignment.staffId, role: 'STAFF', status: 'ACTIVE', approvalStatus: 'APPROVED' },
      select: { id: true },
    });
    if (assignee) recipients.set(assignee.id, 'assignment');
  } else if (input.mode === 'lifecycle' && assignment) {
    const assignee = await tx.user.findFirst({
      where: { id: assignment.staffId, status: 'ACTIVE', approvalStatus: 'APPROVED' },
      select: { id: true },
    });
    if (assignee && !recipients.has(assignee.id)) recipients.set(assignee.id, 'own');
  }

  if (input.actorId) recipients.delete(input.actorId);
  if (!recipients.size) return;

  const actionable = isHallBroadcast(input.type) || input.type === 'TICKET_ASSIGNED';
  await tx.notification.createMany({
    data: [...recipients.entries()].map(([recipientId, audience]) => ({
      eventId: input.ticket.eventId,
      recipientId,
      ticketId: input.ticket.id,
      type: input.type,
      dedupeKey: `${input.type.toLowerCase()}:${input.ticket.id}:${recipientId}:${input.eventToken}`,
      payload: {
        hallId: input.ticket.hallId,
        stallId: input.ticket.stallId,
        stallCode,
        publicNo: input.ticket.publicNo ?? null,
        category: input.ticket.category,
        audience,
        tone: alertTone(input.type, audience),
        actionable,
        eventVersion: input.ticket.version,
        summary: summaryFor(input.type, audience, stallCode, input.ticket.category),
      },
    })),
    skipDuplicates: true,
  });
}

function summaryFor(type: string, audience: AlertAudience, stallCode: string, category: string) {
  if (audience === 'stall') return exhibitorSummary(type);
  if (audience === 'assignment') return assignmentSummary(stallCode);
  if (audience === 'manager' && type === 'TICKET_ASSIGNED') {
    return `Assigned · Stall ${stallCode} · ${serviceCategoryLabel(category)}`;
  }
  if (audience === 'team' || audience === 'own' || isHallBroadcast(type)) return teamBroadcastSummary(type, stallCode, category);
  return `Update · Stall ${stallCode}`;
}

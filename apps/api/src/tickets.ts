import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Param, Post, Query, Sse, UseGuards } from '@nestjs/common';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { ACTIVE_TICKET_STATUSES, TERMINAL_TICKET_STATUSES } from '@eveops/contracts';
import type { AuthScope, TicketStatus } from '@eveops/contracts';
import { routeTicket } from '@eveops/operations';
import { Prisma, TicketPriority } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { CurrentScope, SessionGuard } from './auth';
import { assertScope, assertTransition, requireAuthority } from './domain';
import { PrismaService } from './prisma.service';
import { RealtimeService } from './realtime';
import { correlationId as requestCorrelationId } from './request-context';

export class CreateTicketDto {
  @IsOptional() @IsString() stallId?: string;
  @IsString() @IsIn(['ELECTRICAL', 'HOUSE_HELP', 'HALL_MANAGER']) category!: string;
  @IsString() @IsNotEmpty() subtype!: string;
  @IsString() @Length(3, 500) description!: string;
  @IsOptional() @IsIn(['NORMAL', 'URGENT']) priority: TicketPriority = 'NORMAL';
  @IsString() @IsNotEmpty() idempotencyKey!: string;
}

export class ListTicketsDto {
  @IsOptional() @IsIn(['NEW', 'ASSIGNED', 'SNOOZED', 'QUEUED', 'ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP', 'CLOSED', 'COMPLAINT_RAISED', 'REOPENED', 'ESCALATED', 'CANCELLED'])
  status?: TicketStatus;
  @IsOptional() @IsString() hallId?: string;
  @IsOptional() @IsString() eventId?: string;
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() stallId?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsIn(['ELECTRICAL', 'HOUSE_HELP', 'HALL_MANAGER']) category?: string;
  @IsOptional() @IsIn(['NORMAL', 'URGENT']) priority?: 'NORMAL' | 'URGENT';
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() complaint?: boolean;
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() reopened?: boolean;
  @IsOptional() @IsDateString() createdFrom?: string;
  @IsOptional() @IsDateString() createdTo?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @IsIn(['active', 'closed', 'all']) view: 'active' | 'closed' | 'all' = 'all';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}

export class TransitionTicketDto {
  @IsIn(['ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP', 'REOPENED', 'ESCALATED', 'CANCELLED'])
  to!: TicketStatus;
  @IsOptional() @IsString() @Length(1, 500) reason?: string;
}

export class ReasonDto {
  @IsString() @Length(1, 500) reason!: string;
}

export class PingDto {
  @IsString() @Length(1, 500) message!: string;
}

export class VerifyOtpDto {
  @IsString() @Matches(/^\d{6}$/) otp!: string;
}

export class ComplaintDto {
  @IsIn(['WORK_INCOMPLETE', 'WORK_QUALITY', 'WRONG_SERVICE'])
  reasonCode!: string;
  @IsOptional() @IsString() @Length(1, 500) comment?: string;
  @IsString() @Length(8, 128) idempotencyKey!: string;
}

async function createLifecycleNotifications(
  tx: Prisma.TransactionClient,
  ticket: { id: string; eventId: string; hallId: string; stallId: string; version: number },
  type: string,
  actorId?: string,
) {
  const scopes = await tx.userScope.findMany({
    where: {
      eventId: ticket.eventId,
      OR: [
        { stallId: ticket.stallId, user: { role: 'STALL' } },
        { hallId: ticket.hallId, user: { role: 'HALL_MANAGER' } },
      ],
    },
    select: { userId: true },
  });
  const assignment = await tx.assignment.findFirst({
    where: { ticketId: ticket.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    select: { staffId: true },
    orderBy: { assignedAt: 'desc' },
  });
  const recipients = [...new Set([...scopes.map((item) => item.userId), ...(assignment ? [assignment.staffId] : [])])]
    .filter((recipientId) => recipientId !== actorId);
  const stall = await tx.stall.findUnique({ where: { id: ticket.stallId }, select: { stallCode: true } });
  const record = await tx.ticket.findUnique({ where: { id: ticket.id }, select: { publicNo: true, category: true } });
  const stallCode = stall?.stallCode ?? 'stall';
  const summary = type === 'TICKET_REOPENED'
    ? `Ticket opened again · Stall ${stallCode}`
    : `Update · Stall ${stallCode}`;
  await tx.notification.createMany({
    data: recipients.map((recipientId) => ({
      eventId: ticket.eventId,
      recipientId,
      ticketId: ticket.id,
      type,
      dedupeKey: `${type.toLowerCase()}:${ticket.id}:${recipientId}:${ticket.version}`,
      payload: { hallId: ticket.hallId, stallId: ticket.stallId, stallCode, publicNo: record?.publicNo, category: record?.category, summary },
    })),
    skipDuplicates: true,
  });
}

type TicketProjectionInput = {
  status: string;
  createdAt: Date;
  pool?: { category?: string | null; responseTargetSeconds?: number | null; resolutionTargetSeconds?: number | null } | null;
  assignments: Array<{
    status: string;
    staffId: string;
    responseOverdueAt?: Date | null;
    staff: { id: string; name: string };
  }>;
};

/** Canonical assignee / queue / SLA / capability projection for list and detail. */
export function projectTicketView(ticket: TicketProjectionInput, scope: AuthScope) {
  const latest = ticket.assignments[0];
  const current = latest && ['ACTIVE', 'ACCEPTED'].includes(latest.status) ? latest : undefined;
  const resolutionBreached = !TERMINAL_TICKET_STATUSES.includes(ticket.status as TicketStatus)
    && Date.now() - ticket.createdAt.getTime() > (ticket.pool?.resolutionTargetSeconds ?? 3600) * 1000;
  return {
    currentAssignee: current?.staff ?? null,
    lastAssignee: latest?.staff ?? null,
    queueState: ticket.status === 'QUEUED' ? 'QUEUED' : current ? 'ASSIGNED' : 'NONE',
    slaState: resolutionBreached ? 'SLA_BREACHED' : latest?.responseOverdueAt ? 'RESPONSE_OVERDUE' : 'ON_TRACK',
    capabilities: {
      advanceHallManagerWork: scope.role === 'HALL_MANAGER'
        && current?.staffId === scope.userId
        && ticket.pool?.category === 'HALL_MANAGER',
      verifyStallOtp: ticket.status === 'AWAITING_OTP'
        && (
          (scope.role === 'STAFF' && current?.staffId === scope.userId)
          || scope.role === 'HALL_MANAGER'
        ),
      emergencyClose: ['ADMIN', 'SUPER_ADMIN'].includes(scope.role)
        && ['AWAITING_OTP', 'ESCALATED'].includes(ticket.status),
    },
    nextAction: TERMINAL_TICKET_STATUSES.includes(ticket.status as TicketStatus)
      ? 'NONE'
      : ticket.status === 'QUEUED'
        ? 'WAIT_FOR_ASSIGNMENT'
        : ticket.status === 'AWAITING_OTP'
          ? (
            (scope.role === 'STAFF' && current?.staffId === scope.userId) || scope.role === 'HALL_MANAGER'
              ? 'VERIFY_OTP'
              : 'WAIT_FOR_OTP_VERIFICATION'
          )
          : current ? 'ASSIGNEE_ACTION' : 'ROUTE',
  };
}

@Injectable()
export class TicketService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: AuthScope, query: ListTicketsDto) {
    const where: Prisma.TicketWhereInput = { eventId: { in: scope.eventIds } };
    if (query.eventId) {
      if (!scope.eventIds.includes(query.eventId)) throw new ForbiddenException('Event is outside your scope');
      where.eventId = query.eventId;
    }
    if (scope.role === 'STALL') where.stallId = scope.stallId;
    if (scope.role === 'STAFF') {
      where.assignments = query.view === 'closed'
        ? { some: { staffId: scope.userId } }
        : { some: { staffId: scope.userId, status: { in: ['ACTIVE', 'ACCEPTED'] } } };
    }
    if (scope.role === 'HALL_MANAGER') where.hallId = { in: scope.hallIds };
    if (query.status) where.status = query.status;
    else if (query.view === 'active') where.status = { in: [...ACTIVE_TICKET_STATUSES] };
    else if (query.view === 'closed') where.status = 'CLOSED';
    if (query.category) where.category = query.category;
    if (query.priority) where.priority = query.priority;
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.stallId) {
      if (scope.role === 'STALL' && query.stallId !== scope.stallId) {
        throw new ForbiddenException('Stall is outside your scope');
      }
      if (scope.role !== 'STALL') where.stallId = query.stallId;
    }
    if (query.assigneeId) where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), { assignments: { some: { staffId: query.assigneeId } } }];
    if (query.complaint) where.complaints = { some: {} };
    if (query.reopened) where.reopenCount = { gt: 0 };
    if (query.createdFrom || query.createdTo) {
      where.createdAt = {
        ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
        ...(query.createdTo ? { lte: new Date(query.createdTo) } : {}),
      };
    }
    if (query.search?.trim()) {
      where.OR = [
        { publicNo: { contains: query.search.trim(), mode: 'insensitive' } },
        { stall: { stallCode: { contains: query.search.trim(), mode: 'insensitive' } } },
        { description: { contains: query.search.trim(), mode: 'insensitive' } },
      ];
    }
    if (query.hallId) {
      if (scope.role === 'HALL_MANAGER' && !scope.hallIds.includes(query.hallId)) {
        throw new ForbiddenException('Hall is outside your scope');
      }
      where.hallId = query.hallId;
    }
    const [total, rows] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        include: {
        pool: { select: { category: true, responseTargetSeconds: true, resolutionTargetSeconds: true } },
          stall: true,
          hall: true,
          zone: true,
          assignments: { orderBy: { assignedAt: 'desc' }, take: 1, include: { staff: { select: { id: true, name: true } } } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    ]);
    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: items.map((ticket) => ({
        ...ticket,
        ...projectTicketView(ticket, scope),
      })),
      total,
      nextCursor: hasMore ? items.at(-1)?.id : null,
    };
  }

  async detail(id: string, scope: AuthScope) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        pool: { select: { category: true, responseTargetSeconds: true, resolutionTargetSeconds: true } },
        stall: true,
        hall: true,
        zone: true,
        event: { select: { id: true, name: true, timezone: true } },
        events: { orderBy: { createdAt: 'asc' }, include: { actor: { select: { name: true } } } },
        assignments: {
          orderBy: { assignedAt: 'desc' },
          include: { staff: { select: { id: true, name: true, employeeCode: true } } },
        },
        complaints: { orderBy: { createdAt: 'asc' } },
        otpChallenges: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            createdAt: true,
            expiresAt: true,
            verifiedAt: true,
            attempts: true,
            // Never expose ciphertext / plaintext OTP
          },
        },
      },
    });
    if (!ticket) throw new BadRequestException('Ticket not found');
    assertScope(scope, ticket);
    if (scope.role === 'STAFF' && !ticket.assignments.some((assignment) => assignment.staffId === scope.userId)) {
      throw new BadRequestException('Ticket is not assigned to this staff account');
    }
    const assignmentHistory = [...ticket.assignments].reverse();
    return {
      ...ticket,
      ...projectTicketView(ticket, scope),
      assignmentHistory,
      otpChallenges: ticket.otpChallenges,
    };
  }

  async activity(id: string, scope: AuthScope, cursor?: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, eventId: true, hallId: true, stallId: true, assignments: { select: { staffId: true } } },
    });
    if (!ticket) throw new BadRequestException('Ticket not found');
    assertScope(scope, ticket);
    if (scope.role === 'STAFF' && !ticket.assignments.some((assignment) => assignment.staffId === scope.userId)) {
      throw new BadRequestException('Ticket is not assigned to this staff account');
    }
    const rows = await this.prisma.ticketEvent.findMany({
      where: { ticketId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, eventType: true, createdAt: true, actor: { select: { name: true } } },
    });
    const hasMore = rows.length > 20;
    const items = (hasMore ? rows.slice(0, 20) : rows).map((event) => ({
      id: event.id,
      eventType: event.eventType,
      createdAt: event.createdAt,
      actorName: event.actor?.name ?? 'System',
    }));
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  async create(dto: CreateTicketDto, scope: AuthScope) {
    if (scope.role === 'STAFF') throw new BadRequestException('Staff cannot create stall tickets');
    const stallId = scope.role === 'STALL' ? scope.stallId : dto.stallId;
    if (!stallId) throw new BadRequestException('A stall is required for tickets created on behalf of an exhibitor');
    const stall = await this.prisma.stall.findUnique({ where: { id: stallId }, include: { zone: { include: { hall: true } } } });
    if (!stall) throw new BadRequestException('Invalid stall');
    const target = { eventId: stall.zone.hall.eventId, hallId: stall.zone.hallId, stallId: stall.id };
    assertScope(scope, target);
    const event = await this.prisma.event.findUniqueOrThrow({ where: { id: target.eventId }, select: { status: true } });
    if (!stall.active || !stall.zone.active || !stall.zone.hall.active || event.status !== 'ACTIVE') {
      throw new BadRequestException('This stall location is not active for ticket creation');
    }
    const assertSameRequest = (ticket: { stallId: string; category: string; subtype: string; description: string; priority: TicketPriority }) => {
      if (ticket.stallId !== stallId || ticket.category !== dto.category || ticket.subtype !== dto.subtype || ticket.description !== dto.description || ticket.priority !== dto.priority) {
        throw new BadRequestException('Idempotency key was already used for a different ticket request');
      }
    };
    const existing = await this.prisma.ticket.findUnique({ where: { createdById_idempotencyKey: { createdById: scope.userId, idempotencyKey: dto.idempotencyKey } } });
    if (existing) {
      assertSameRequest(existing);
      if (['NEW', 'REOPENED'].includes(existing.status)) await this.route(existing.id, undefined, requestCorrelationId());
      return this.detail(existing.id, scope);
    }
    const pool = await this.prisma.servicePool.findFirst({ where: { eventId: target.eventId, hallId: target.hallId, category: dto.category, subtype: dto.subtype, active: true } });
    if (!pool) throw new BadRequestException('This service is not configured for the stall hall');
    let ticket;
    try {
      ticket = await this.prisma.$transaction(async (tx) => {
      const sequence = await tx.event.update({
        where: { id: target.eventId },
        data: { ticketSequence: { increment: 1 } },
        select: { ticketSequence: true },
      });
      const created = await tx.ticket.create({
        data: { publicNo: 'EV-' + String(sequence.ticketSequence).padStart(5, '0'), ...target, zoneId: stall.zoneId, poolId: pool.id, category: dto.category, subtype: dto.subtype, description: dto.description, priority: dto.priority, createdById: scope.userId, idempotencyKey: dto.idempotencyKey },
      });
      await tx.ticketEvent.create({ data: { eventId: target.eventId, ticketId: created.id, eventType: 'TICKET_CREATED', actorId: scope.userId, toStatus: 'NEW', correlationId: requestCorrelationId() } });
      await tx.outboxEvent.create({ data: { eventId: target.eventId, aggregateType: 'Ticket', aggregateId: created.id, eventType: 'TICKET_CREATED', payload: { ticketId: created.id, ...target } } });
      const recipients = await tx.userScope.findMany({
        where: {
          eventId: target.eventId,
          OR: [
            { stallId: target.stallId, user: { role: 'STALL' } },
            { hallId: target.hallId, user: { role: 'HALL_MANAGER' } },
          ],
        },
        select: { userId: true },
      });
      await tx.notification.createMany({
        data: recipients.map(({ userId }) => ({
          eventId: target.eventId,
          recipientId: userId,
          ticketId: created.id,
          type: 'TICKET_CREATED',
          dedupeKey: 'ticket-created:' + created.id + ':' + userId,
          payload: {
            hallId: target.hallId,
            stallId: target.stallId,
            stallCode: stall.stallCode,
            publicNo: created.publicNo,
            category: dto.category,
            summary: `New request · Stall ${stall.stallCode} · ${dto.category === 'HOUSE_HELP' ? 'House Help' : dto.category === 'HALL_MANAGER' ? 'Hall Manager' : 'Electrical'}`,
          },
        })),
        skipDuplicates: true,
      });
      return created;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const concurrent = await this.prisma.ticket.findUniqueOrThrow({
        where: { createdById_idempotencyKey: { createdById: scope.userId, idempotencyKey: dto.idempotencyKey } },
      });
      assertSameRequest(concurrent);
      ticket = concurrent;
    }
    await this.route(ticket.id, undefined, requestCorrelationId());
    return this.detail(ticket.id, scope);
  }

  async route(ticketId: string, actorId?: string, correlationId = requestCorrelationId()) {
    const result = await routeTicket(this.prisma, ticketId, actorId, correlationId);
    return result.requested;
  }

  async transition(id: string, to: TicketStatus, scope: AuthScope, reason?: string) {
    if (to === 'CLOSED') throw new BadRequestException('Use OTP verification or authorized override closure');
    if (to === 'COMPLAINT_RAISED') throw new BadRequestException('Use the complaint action');
    if (to === 'SNOOZED') throw new BadRequestException('Use the assigned-staff snooze action');
    if (to === 'ASSIGNED' || to === 'QUEUED') throw new BadRequestException('Assignment state is controlled by routing');
    const result = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      assertScope(scope, ticket);
      assertTransition(ticket.status as TicketStatus, to);
      const assignment = await tx.assignment.findFirst({ where: { ticketId: id, status: { in: ['ACTIVE', 'ACCEPTED'] } }, orderBy: { assignedAt: 'desc' } });
      const isCurrentAssignee = ['STAFF', 'HALL_MANAGER'].includes(scope.role) && assignment?.staffId === scope.userId;
      if (to === 'ACCEPTED' && !isCurrentAssignee) throw new BadRequestException('Only the current assignee can accept');
      if (['IN_PROGRESS', 'AWAITING_OTP'].includes(to) && !isCurrentAssignee) {
        requireAuthority(scope.role, 'HALL_MANAGER');
        if (!reason?.trim()) throw new BadRequestException('A manager override reason is required');
      }
      if (['REOPENED', 'ESCALATED'].includes(to)) {
        requireAuthority(scope.role, 'HALL_MANAGER');
        if (!reason?.trim()) throw new BadRequestException('A reason is required');
      }
      if (to === 'CANCELLED') {
        requireAuthority(scope.role, 'ADMIN');
        if (!reason?.trim()) throw new BadRequestException('A cancellation reason is required');
      }
      const now = new Date();
      const data: Prisma.TicketUpdateInput = { status: to, version: { increment: 1 } };
      if (to === 'ESCALATED') data.escalationLevel = { increment: 1 };
      if (to === 'ACCEPTED') { data.firstAcceptedAt = ticket.firstAcceptedAt ?? now; if (assignment) await tx.assignment.update({ where: { id: assignment.id }, data: { status: 'ACCEPTED', acceptedAt: now } }); }
      if (to === 'IN_PROGRESS') { data.firstStartedAt = ticket.firstStartedAt ?? now; if (assignment) await tx.assignment.update({ where: { id: assignment.id }, data: { startedAt: now } }); }
      if (to === 'AWAITING_OTP') {
        data.completionRequestedAt = now;
        if (assignment) await tx.assignment.update({ where: { id: assignment.id }, data: { completionRequestedAt: now } });
        const otp = String(randomInt(100000, 1000000));
        await tx.otpChallenge.updateMany({
          where: { ticketId: id, verifiedAt: null, invalidatedAt: null },
          data: { activeTicketKey: null, invalidatedAt: now },
        });
        await tx.otpChallenge.create({
          data: {
            eventId: ticket.eventId,
            ticketId: id,
            otpHash: createHash('sha256').update(otp).digest('hex'),
            otpCiphertext: this.protectOtp(otp),
            activeTicketKey: id,
            expiresAt: new Date(now.getTime() + 600000),
          },
        });
        await tx.ticketEvent.create({
          data: { eventId: ticket.eventId, ticketId: id, eventType: 'OTP_GENERATED', actorId: scope.userId, correlationId: requestCorrelationId() },
        });
      }
      if (ticket.status === 'AWAITING_OTP') {
        await tx.otpChallenge.updateMany({
          where: { ticketId: id, verifiedAt: null, invalidatedAt: null },
          data: { activeTicketKey: null, invalidatedAt: now },
        });
      }
      if (to === 'REOPENED') {
        data.reopenCount = { increment: 1 };
        data.closedAt = null;
        data.completionRequestedAt = null;
        data.queuePriorityOverrideAt = null;
        if (assignment) {
          await tx.assignment.update({
            where: { id: assignment.id },
            data: { status: 'RELEASED', activeTicketKey: null, releasedAt: now, releaseReason: reason ?? 'Ticket reopened' },
          });
          if (ticket.poolId) {
            await tx.workforceMembership.updateMany({
              where: { poolId: ticket.poolId, userId: assignment.staffId },
              data: { lastAvailableAt: now },
            });
          }
        }
      }
      const updated = await tx.ticket.update({ where: { id, version: ticket.version }, data });
      await tx.ticketEvent.create({
        data: {
          eventId: ticket.eventId,
          ticketId: id,
          eventType: 'STATUS_' + to,
          actorId: scope.userId,
          fromStatus: ticket.status,
          toStatus: to,
          correlationId: requestCorrelationId(),
          metadata: reason ? { reason, ...(to === 'ESCALATED' ? { escalationLevel: ticket.escalationLevel + 1 } : {}) } : Prisma.JsonNull,
        },
      });
      await tx.outboxEvent.create({ data: { eventId: ticket.eventId, aggregateType: 'Ticket', aggregateId: id, eventType: 'STATUS_' + to, payload: { ticketId: id, eventId: ticket.eventId, hallId: ticket.hallId } } });
      await createLifecycleNotifications(tx, updated, 'TICKET_' + to, scope.userId);
      return { ticket: updated, releasedStaffId: to === 'REOPENED' ? assignment?.staffId : undefined };
    });
    if (to === 'REOPENED') {
      await this.route(id, undefined, requestCorrelationId());
      await this.assignWaitingForReleasedStaff(result.releasedStaffId ? [result.releasedStaffId] : []);
    }
    return result.ticket;
  }

  async snooze(id: string, scope: AuthScope) {
    if (scope.role !== 'STAFF') throw new ForbiddenException('Only assigned staff can snooze');
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      assertScope(scope, ticket);
      if (ticket.status !== 'ASSIGNED') throw new BadRequestException('Snooze is available only for a new assignment');
      const assignment = await tx.assignment.findFirst({ where: { ticketId: id, staffId: scope.userId, status: 'ACTIVE' } });
      if (!assignment || assignment.snoozedUntil) throw new BadRequestException('Snooze unavailable');
      const snoozedUntil = new Date(assignment.assignedAt.getTime() + 600000);
      const assignmentUpdate = await tx.assignment.updateMany({
        where: { id: assignment.id, status: 'ACTIVE', snoozedUntil: null },
        data: { snoozedUntil },
      });
      if (assignmentUpdate.count !== 1) throw new BadRequestException('Snooze was already used');
      const ticketUpdate = await tx.ticket.updateMany({
        where: { id, version: ticket.version, status: 'ASSIGNED' },
        data: { status: 'SNOOZED', version: { increment: 1 } },
      });
      if (ticketUpdate.count !== 1) throw new BadRequestException('Ticket changed before snooze was confirmed');
      const updated = await tx.ticket.findUniqueOrThrow({ where: { id } });
      await tx.ticketEvent.create({ data: { eventId: ticket.eventId, ticketId: id, eventType: 'ASSIGNMENT_SNOOZED', actorId: scope.userId, fromStatus: 'ASSIGNED', toStatus: 'SNOOZED', correlationId: requestCorrelationId() } });
      await tx.outboxEvent.create({ data: { eventId: ticket.eventId, aggregateType: 'Ticket', aggregateId: id, eventType: 'ASSIGNMENT_SNOOZED', payload: { ticketId: id, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId, assigneeId: scope.userId } } });
      return updated;
    });
  }

  async generateOtp(id: string, scope: AuthScope) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${id} FOR UPDATE`;
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      assertScope(scope, ticket);
      if (scope.role !== 'STALL') throw new ForbiddenException('Only the bound stall can regenerate an OTP');
      if (ticket.status !== 'AWAITING_OTP') throw new BadRequestException('Ticket is not awaiting OTP');
      const latest = await tx.otpChallenge.findFirst({ where: { ticketId: id }, orderBy: { createdAt: 'desc' } });
      if (latest && Date.now() - latest.createdAt.getTime() < 30000) {
        throw new BadRequestException('Please wait 30 seconds before requesting another OTP');
      }
      const now = new Date();
      const otp = String(randomInt(100000, 1000000));
      await tx.otpChallenge.updateMany({
        where: { ticketId: id, verifiedAt: null, invalidatedAt: null },
        data: { activeTicketKey: null, invalidatedAt: now },
      });
      await tx.otpChallenge.create({
        data: {
          eventId: ticket.eventId,
          ticketId: id,
          otpHash: createHash('sha256').update(otp).digest('hex'),
          otpCiphertext: this.protectOtp(otp),
          activeTicketKey: id,
          expiresAt: new Date(now.getTime() + 600000),
        },
      });
      const correlationId = requestCorrelationId();
      await tx.ticketEvent.create({
        data: { eventId: ticket.eventId, ticketId: id, eventType: 'OTP_REGENERATED', actorId: scope.userId, correlationId },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: ticket.eventId,
          aggregateType: 'Ticket',
          aggregateId: id,
          eventType: 'OTP_REGENERATED',
          payload: { ticketId: id, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId, version: ticket.version, correlationId },
        },
      });
      return { expiresInSeconds: 600 };
    });
  }

  async presentOtp(id: string, scope: AuthScope) {
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id } });
    assertScope(scope, ticket);
    if (scope.role !== 'STALL') throw new ForbiddenException('Only the bound stall can view this OTP');
    if (ticket.status === 'CLOSED') throw new BadRequestException('Completion already verified');
    if (ticket.status !== 'AWAITING_OTP') throw new BadRequestException('Ticket is not awaiting OTP');
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { ticketId: id, invalidatedAt: null, verifiedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw new BadRequestException('OTP unavailable or expired');
    if (challenge.expiresAt <= new Date()) {
      return { otp: null as string | null, expiresAt: challenge.expiresAt, expired: true as const };
    }
    return { otp: this.unprotectOtp(challenge.otpCiphertext), expiresAt: challenge.expiresAt, expired: false as const };
  }

  async regenerateOtp(id: string, scope: AuthScope) {
    return this.generateOtp(id, scope);
  }

  async verifyOtp(id: string, otp: string, scope: AuthScope) {
    const result = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      assertScope(scope, ticket);
      if (!['STAFF', 'HALL_MANAGER'].includes(scope.role)) {
        throw new ForbiddenException('Only assigned staff or the hall manager can enter the stall completion code');
      }
      const priorAssignment = await tx.assignment.findFirst({
        where: { ticketId: id, staffId: scope.userId },
        orderBy: { assignedAt: 'desc' },
      });
      if (ticket.status === 'CLOSED') {
        if (scope.role === 'STAFF' && !priorAssignment) {
          throw new ForbiddenException('Only assigned staff or the hall manager can verify completion');
        }
        return { invalidOtp: false as const, expired: false as const, ticket, releasedStaffIds: [] as string[] };
      }
      if (ticket.status !== 'AWAITING_OTP') throw new BadRequestException('Ticket is not awaiting OTP');
      if (scope.role === 'STAFF') {
        const assignment = await tx.assignment.findFirst({
          where: { ticketId: id, staffId: scope.userId, status: { in: ['ACTIVE', 'ACCEPTED'] } },
          orderBy: { assignedAt: 'desc' },
        });
        if (!assignment) throw new ForbiddenException('Only assigned staff or the hall manager can enter the stall completion code');
      }
      const challenge = await tx.otpChallenge.findFirst({ where: { ticketId: id, activeTicketKey: id, invalidatedAt: null, verifiedAt: null }, orderBy: { createdAt: 'desc' } });
      const now = new Date();
      if (!challenge || challenge.attempts >= 5) throw new BadRequestException('OTP unavailable or expired');
      if (challenge.expiresAt <= now) {
        return { invalidOtp: false as const, expired: true as const };
      }
      if (challenge.otpHash !== createHash('sha256').update(otp).digest('hex')) {
        await tx.otpChallenge.updateMany({
          where: { id: challenge.id, invalidatedAt: null, verifiedAt: null, attempts: { lt: 5 } },
          data: { attempts: { increment: 1 } },
        });
        await tx.ticketEvent.create({
          data: {
            eventId: ticket.eventId,
            ticketId: id,
            eventType: 'OTP_VERIFY_FAILED',
            actorId: scope.userId,
            fromStatus: 'AWAITING_OTP',
            toStatus: 'AWAITING_OTP',
            correlationId: requestCorrelationId(),
            metadata: { reason: 'mismatch' },
          },
        });
        return { invalidOtp: true as const, expired: false as const };
      }
      const challengeUpdate = await tx.otpChallenge.updateMany({
        where: { id: challenge.id, activeTicketKey: id, invalidatedAt: null, verifiedAt: null },
        data: { activeTicketKey: null, verifiedAt: now, verifiedBy: scope.userId },
      });
      if (challengeUpdate.count !== 1) throw new BadRequestException('OTP challenge is no longer active');
      const ticketUpdate = await tx.ticket.updateMany({
        where: { id, version: ticket.version, status: 'AWAITING_OTP' },
        data: { status: 'CLOSED', closedAt: now, version: { increment: 1 } },
      });
      if (ticketUpdate.count !== 1) throw new BadRequestException('Ticket changed before OTP verification completed');
      const releasedAssignments = await tx.assignment.findMany({
        where: { ticketId: id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
        select: { staffId: true },
      });
      await tx.assignment.updateMany({
        where: { ticketId: id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
        data: { status: 'RELEASED', activeTicketKey: null, releasedAt: now, releaseReason: 'OTP verified' },
      });
      await tx.complaint.updateMany({
        where: { ticketId: id, resolution: null },
        data: { resolution: 'Resolved by stall-supplied completion code' },
      });
      if (releasedAssignments.length) {
        await tx.workforceMembership.updateMany({
          where: { userId: { in: releasedAssignments.map((assignment) => assignment.staffId) } },
          data: { lastAvailableAt: now },
        });
      }
      const correlationId = requestCorrelationId();
      const enteredBy = scope.role === 'HALL_MANAGER' ? 'HALL_MANAGER' : 'ASSIGNED_STAFF';
      await tx.ticketEvent.create({
        data: {
          eventId: ticket.eventId,
          ticketId: id,
          eventType: 'OTP_VERIFIED',
          actorId: scope.userId,
          fromStatus: 'AWAITING_OTP',
          toStatus: 'CLOSED',
          correlationId,
          metadata: { enteredBy, credentialSource: 'STALL_DISPLAYED' },
        },
      });
      await tx.ticketEvent.create({
        data: {
          eventId: ticket.eventId,
          ticketId: id,
          eventType: 'TICKET_CLOSED',
          actorId: scope.userId,
          fromStatus: 'AWAITING_OTP',
          toStatus: 'CLOSED',
          correlationId,
        },
      });
      await tx.outboxEvent.create({ data: { eventId: ticket.eventId, aggregateType: 'Ticket', aggregateId: id, eventType: 'OTP_VERIFIED', payload: { ticketId: id, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId } } });
      const updated = await tx.ticket.findUniqueOrThrow({ where: { id } });
      await createLifecycleNotifications(tx, updated, 'TICKET_CLOSED', scope.userId);
      return { invalidOtp: false as const, expired: false as const, ticket: updated, releasedStaffIds: releasedAssignments.map((assignment) => assignment.staffId) };
    });
    if (result.expired) throw new BadRequestException('OTP expired');
    if (result.invalidOtp) throw new BadRequestException('Invalid OTP');
    const closed = result.ticket;
    await this.assignWaitingForReleasedStaff(result.releasedStaffIds);
    return closed;
  }

  async complaint(id: string, scope: AuthScope, reasonCode: string, comment: string | undefined, idempotencyKey: string) {
    if (scope.role === 'STAFF') throw new BadRequestException('Staff cannot raise complaints');
    if (!['WORK_INCOMPLETE', 'WORK_QUALITY', 'WRONG_SERVICE'].includes(reasonCode)) throw new BadRequestException('A valid complaint reason is required');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope.userId}:${idempotencyKey}`}, 2))`);
      const existing = await tx.complaint.findUnique({
        where: { createdBy_idempotencyKey: { createdBy: scope.userId, idempotencyKey } },
        include: { ticket: true },
      });
      if (existing) {
        assertScope(scope, existing.ticket);
        return existing.ticket;
      }
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      assertScope(scope, ticket);
      if (!['AWAITING_OTP', 'CLOSED'].includes(ticket.status)) throw new BadRequestException('Complaint is not available');
      const now = new Date();
      await tx.complaint.create({ data: { eventId: ticket.eventId, ticketId: id, reasonCode, comment, createdBy: scope.userId, idempotencyKey } });
      const nextStatus = 'COMPLAINT_RAISED';
      if (ticket.status === 'AWAITING_OTP') {
        await tx.otpChallenge.updateMany({
          where: { ticketId: id, invalidatedAt: null, verifiedAt: null },
          data: { activeTicketKey: null, invalidatedAt: now },
        });
      }
      const ticketUpdate = await tx.ticket.updateMany({
        where: { id, version: ticket.version, status: ticket.status },
        data: { status: nextStatus, version: { increment: 1 } },
      });
      if (ticketUpdate.count !== 1) throw new BadRequestException('Ticket changed before complaint was recorded');
      await tx.ticketEvent.create({ data: { eventId: ticket.eventId, ticketId: id, eventType: 'COMPLAINT_RAISED', actorId: scope.userId, fromStatus: ticket.status, toStatus: nextStatus, correlationId: requestCorrelationId(), metadata: { reasonCode, comment: comment ?? null } } });
      await tx.outboxEvent.create({ data: { eventId: ticket.eventId, aggregateType: 'Ticket', aggregateId: id, eventType: 'COMPLAINT_RAISED', payload: { ticketId: id, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId } } });
      const updated = await tx.ticket.findUniqueOrThrow({ where: { id } });
      await createLifecycleNotifications(tx, updated, 'COMPLAINT_RAISED', scope.userId);
      return updated;
    });
  }

  async overrideClose(id: string, scope: AuthScope, reason: string) {
    requireAuthority(scope.role, 'ADMIN');
    if (!reason?.trim()) throw new BadRequestException('Reason required');
    const ticket = await this.prisma.ticket.findUniqueOrThrow({ where: { id } });
    assertScope(scope, ticket);
    if (!['AWAITING_OTP', 'ESCALATED'].includes(ticket.status)) {
      throw new BadRequestException('Emergency close is allowed only while awaiting OTP or escalated');
    }
    const closure = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const ticketUpdate = await tx.ticket.updateMany({ where: { id, version: ticket.version, status: ticket.status }, data: { status: 'CLOSED', closedAt: now, version: { increment: 1 } } });
      if (ticketUpdate.count !== 1) throw new BadRequestException('Ticket changed before emergency closure completed');
      await tx.otpChallenge.updateMany({
        where: { ticketId: id, invalidatedAt: null, verifiedAt: null },
        data: { activeTicketKey: null, invalidatedAt: now },
      });
      const releasedAssignments = await tx.assignment.findMany({
        where: { ticketId: id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
        select: { staffId: true },
      });
      await tx.assignment.updateMany({
        where: { ticketId: id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
        data: { status: 'RELEASED', activeTicketKey: null, releasedAt: now, releaseReason: 'Emergency close: ' + reason },
      });
      await tx.complaint.updateMany({
        where: { ticketId: id, resolution: null },
        data: { resolution: `Resolved by emergency closure: ${reason}` },
      });
      if (releasedAssignments.length) {
        await tx.workforceMembership.updateMany({
          where: { userId: { in: releasedAssignments.map((assignment) => assignment.staffId) } },
          data: { lastAvailableAt: now },
        });
      }
      await tx.ticketEvent.create({ data: { eventId: ticket.eventId, ticketId: id, eventType: 'OVERRIDE_CLOSED', actorId: scope.userId, fromStatus: ticket.status, toStatus: 'CLOSED', correlationId: requestCorrelationId(), metadata: { reason } } });
      await tx.outboxEvent.create({ data: { eventId: ticket.eventId, aggregateType: 'Ticket', aggregateId: id, eventType: 'OVERRIDE_CLOSED', payload: { ticketId: id, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId } } });
      const updated = await tx.ticket.findUniqueOrThrow({ where: { id } });
      await createLifecycleNotifications(tx, updated, 'TICKET_OVERRIDE_CLOSED', scope.userId);
      return { ticket: updated, releasedStaffIds: releasedAssignments.map((assignment) => assignment.staffId) };
    });
    await this.assignWaitingForReleasedStaff(closure.releasedStaffIds);
    return closure.ticket;
  }

  async prioritizeQueued(id: string, scope: AuthScope, reason: string) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    if (!reason?.trim()) throw new BadRequestException('Priority override reason is required');
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      assertScope(scope, ticket);
      if (ticket.status !== 'QUEUED') throw new BadRequestException('Only queued tickets can be prioritized');
      const updated = await tx.ticket.update({
        where: { id, version: ticket.version },
        data: { queuePriorityOverrideAt: new Date(), version: { increment: 1 } },
      });
      const correlationId = requestCorrelationId();
      await tx.ticketEvent.create({
        data: {
          eventId: ticket.eventId,
          ticketId: id,
          eventType: 'QUEUE_PRIORITY_OVERRIDDEN',
          actorId: scope.userId,
          fromStatus: 'QUEUED',
          toStatus: 'QUEUED',
          correlationId,
          metadata: { reason },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: ticket.eventId,
          aggregateType: 'Ticket',
          aggregateId: id,
          eventType: 'QUEUE_PRIORITY_OVERRIDDEN',
          payload: {
            ticketId: id,
            eventId: ticket.eventId,
            hallId: ticket.hallId,
            stallId: ticket.stallId,
            version: updated.version,
            correlationId,
          },
        },
      });
      return updated;
    });
  }

  async ping(id: string, scope: AuthScope, message: string) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    if (!message.trim()) throw new BadRequestException('Ping message is required');
    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
      assertScope(scope, ticket);
      const assignment = await tx.assignment.findFirst({
        where: { ticketId: id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
        orderBy: { assignedAt: 'desc' },
      });
      if (!assignment) throw new BadRequestException('Ticket has no current assignee');
      await tx.notification.create({
        data: {
          eventId: ticket.eventId,
          recipientId: assignment.staffId,
          ticketId: id,
          type: 'STAFF_PINGED',
          dedupeKey: `staff-pinged:${id}:${assignment.id}:${ticket.version}:${Date.now()}`,
          payload: { message: message.trim(), actorId: scope.userId },
        },
      });
      await tx.ticketEvent.create({
        data: {
          eventId: ticket.eventId,
          ticketId: id,
          eventType: 'STAFF_PINGED',
          actorId: scope.userId,
          fromStatus: ticket.status,
          toStatus: ticket.status,
          correlationId: requestCorrelationId(),
          metadata: { staffId: assignment.staffId, message: message.trim() },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: ticket.eventId,
          aggregateType: 'Ticket',
          aggregateId: id,
          eventType: 'STAFF_PINGED',
          payload: { ticketId: id, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId, assigneeId: assignment.staffId },
        },
      });
      return { pinged: true };
    });
  }

  private async assignNextWaiting(poolId: string | null) {
    if (!poolId) return;
    const waiting = await this.prisma.ticket.findFirst({
      where: { poolId, status: 'QUEUED' },
      orderBy: [{ queuePriorityOverrideAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    if (waiting) await this.route(waiting.id, undefined, requestCorrelationId());
  }

  private async assignWaitingForReleasedStaff(staffIds: string[]) {
    if (!staffIds.length) return;
    const memberships = await this.prisma.workforceMembership.findMany({
      where: { userId: { in: [...new Set(staffIds)] }, availability: 'ON_DUTY' },
      select: { poolId: true },
      orderBy: { lastAvailableAt: 'asc' },
    });
    for (const poolId of [...new Set(memberships.map((membership) => membership.poolId))]) {
      await this.assignNextWaiting(poolId);
    }
  }

  private otpKey() {
    const secret = process.env.OTP_ENCRYPTION_SECRET;
    if (!secret || secret.length < 32) throw new Error('OTP_ENCRYPTION_SECRET must contain at least 32 characters');
    if (process.env.NODE_ENV === 'production' && secret === process.env.SESSION_SECRET) {
      throw new Error('OTP_ENCRYPTION_SECRET must be distinct from SESSION_SECRET');
    }
    return createHash('sha256').update(secret).digest();
  }

  private protectOtp(otp: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.otpKey(), iv);
    const encrypted = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }

  private unprotectOtp(value: string) {
    const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.otpKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}

@UseGuards(SessionGuard)
@Controller('tickets')
export class TicketController {
  constructor(private readonly service: TicketService, private readonly realtime: RealtimeService) {}
  @Get() list(@CurrentScope() scope: AuthScope, @Query() query: ListTicketsDto) { return this.service.list(scope, query); }
  @Get(':id/activity') activity(@Param('id') id: string, @CurrentScope() scope: AuthScope, @Query('cursor') cursor?: string) {
    return this.service.activity(id, scope, cursor);
  }
  @Get(':id') detail(@Param('id') id: string, @CurrentScope() scope: AuthScope) { return this.service.detail(id, scope); }
  @Post() create(@Body() dto: CreateTicketDto, @CurrentScope() scope: AuthScope) { return this.service.create(dto, scope); }
  @Post(':id/transition') transition(@Param('id') id: string, @Body() body: TransitionTicketDto, @CurrentScope() scope: AuthScope) { return this.service.transition(id, body.to, scope, body.reason); }
  @Post(':id/snooze') snooze(@Param('id') id: string, @CurrentScope() scope: AuthScope) { return this.service.snooze(id, scope); }
  @Get(':id/otp')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  otp(@Param('id') id: string, @CurrentScope() scope: AuthScope) { return this.service.presentOtp(id, scope); }
  @Post(':id/otp/verify')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  verify(@Param('id') id: string, @Body() body: VerifyOtpDto, @CurrentScope() scope: AuthScope) { return this.service.verifyOtp(id, body.otp, scope); }
  @Post(':id/otp/regenerate')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  regenerate(@Param('id') id: string, @CurrentScope() scope: AuthScope) { return this.service.regenerateOtp(id, scope); }
  @Post(':id/complaints') complaint(@Param('id') id: string, @Body() body: ComplaintDto, @CurrentScope() scope: AuthScope) { return this.service.complaint(id, scope, body.reasonCode, body.comment, body.idempotencyKey); }
  @Post(':id/override-close') override(@Param('id') id: string, @Body() body: ReasonDto, @CurrentScope() scope: AuthScope) { return this.service.overrideClose(id, scope, body.reason); }
  @Post(':id/prioritize')
  prioritize(@Param('id') id: string, @Body() body: ReasonDto, @CurrentScope() scope: AuthScope) { return this.service.prioritizeQueued(id, scope, body.reason); }
  @Post(':id/ping')
  ping(@Param('id') id: string, @Body() body: PingDto, @CurrentScope() scope: AuthScope) { return this.service.ping(id, scope, body.message); }
  @Sse('stream/live') stream(@CurrentScope() scope: AuthScope) { return this.realtime.stream(scope); }
}

import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ACTIVE_TICKET_STATUSES, type AuthScope, type ServicePriority } from '@eveops/contracts';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { boundedElapsedSeconds, closedResolutionSeconds, displayLiveAgeSeconds } from '@eveops/operations';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Throttle } from '@nestjs/throttler';
import { CurrentScope, SessionGuard } from './auth';
import { IsNewPassword } from './password-policy';
import { requireAuthority } from './domain';
import { PrismaService } from './prisma.service';
import { stallCodeConflictMessage } from './stall-conflict';

export class MetricsQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['today', 'event', 'custom']) range?: 'today' | 'event' | 'custom';
  @IsOptional() @IsString() eventId?: string;
}

export class UpdatePoolDto {
  @Type(() => Number) @IsInt() @Min(1) responseTargetSeconds!: number;
  @Type(() => Number) @IsInt() @Min(1) resolutionTargetSeconds!: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateMasterBodyDto {
  @IsString() @MinLength(1) eventId!: string;
  @IsOptional() @IsString() @MinLength(1) code?: string;
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsString() hallId?: string;
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() @MinLength(1) stallCode?: string;
  @IsOptional() @IsString() @MinLength(1) exhibitorName?: string;
  @IsOptional() @IsString() contact?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(['HIGH', 'MEDIUM', 'LOW']) servicePriority?: ServicePriority;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
}

export class UpdateRegistrationDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) stallCode?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) exhibitorName?: string;
  @IsOptional() @IsString() @MaxLength(80) contact?: string;
  @IsOptional() @IsIn(['HIGH', 'MEDIUM', 'LOW']) servicePriority?: ServicePriority;
}

export class TransferRegistrationDto {
  @IsString() @MinLength(1) @MaxLength(64) destinationStallId!: string;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class ArchiveRegistrationDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class CreateRegistrationLoginDto {
  @IsString() @MinLength(1) eventId!: string;
  @IsString() @MinLength(1) zoneId!: string;
  @IsString() @MinLength(1) @MaxLength(40) stallCode!: string;
  @IsString() @MinLength(1) @MaxLength(120) exhibitorName!: string;
  @IsOptional() @IsString() @MaxLength(80) contact?: string;
  @IsOptional() @IsIn(['HIGH', 'MEDIUM', 'LOW']) servicePriority?: ServicePriority;
  @IsString() @MinLength(2) @MaxLength(120) loginName!: string;
  @IsEmail() loginEmail!: string;
  @IsString() @MinLength(8) @MaxLength(80) idempotencyKey!: string;
}

export class CreateExhibitorLoginDto {
  @IsString() @MinLength(2) @MaxLength(120) loginName!: string;
  @IsEmail() loginEmail!: string;
  @IsString() @MinLength(8) @MaxLength(80) idempotencyKey!: string;
}

export class CreateAdminDto {
  @IsString() @MinLength(2) name!: string;
  @IsEmail() email!: string;
  @IsString() @IsNewPassword() password!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) eventIds!: string[];
}

export class CreateExportDto {
  @IsIn(['CSV', 'XLSX', 'csv', 'xlsx']) format!: string;
  @IsOptional() @IsObject() filters?: Record<string, unknown>;
  @IsOptional() columns?: unknown;
}

export class AuditQueryDto {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() ticket?: string;
}

@Injectable()
export class ManagementService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(scope: AuthScope, query: MetricsQueryDto = {}) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    if (query.eventId && !scope.eventIds.includes(query.eventId)) throw new ForbiddenException('Event is outside your scope');
    const where: Prisma.TicketWhereInput = {
      eventId: query.eventId ?? { in: scope.eventIds },
      ...(scope.role === 'HALL_MANAGER' ? { hallId: { in: scope.hallIds } } : {}),
    };
    if (query.from || query.to || query.range === 'today') {
      const createdAt: Prisma.DateTimeFilter = {};
      if (query.range === 'today') {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        createdAt.gte = start;
      }
      if (query.from) createdAt.gte = new Date(query.from);
      if (query.to) createdAt.lte = new Date(query.to);
      where.createdAt = createdAt;
    }
    const [openTickets, queued, overdue, escalated, complaints, closedCandidates, statusGroups] = await Promise.all([
      this.prisma.ticket.findMany({
        where: { ...where, status: { notIn: ['CLOSED', 'CANCELLED'] } },
        select: { createdAt: true, firstAcceptedAt: true, pool: { select: { responseTargetSeconds: true, resolutionTargetSeconds: true } } },
      }),
      this.prisma.ticket.count({ where: { ...where, status: 'QUEUED' } }),
      this.prisma.assignment.count({ where: { ticket: where, status: { in: ['ACTIVE', 'ACCEPTED'] }, responseOverdueAt: { not: null } } }),
      this.prisma.ticket.count({ where: { ...where, status: 'ESCALATED' } }),
      this.prisma.complaint.count({ where: { resolution: null, ticket: where } }),
      this.prisma.ticket.findMany({
        where: { ...where, status: 'CLOSED', closedAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
        select: { closedAt: true, event: { select: { timezone: true } } },
      }),
      this.prisma.ticket.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    const closedToday = closedCandidates.filter((ticket) => {
      if (!ticket.closedAt) return false;
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: ticket.event.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return formatter.format(ticket.closedAt) === formatter.format(new Date());
    }).length;
    const now = Date.now();
    const slaBreached = openTickets.filter((ticket) => {
      const responseBreached = !ticket.firstAcceptedAt && now - ticket.createdAt.getTime() > (ticket.pool?.responseTargetSeconds ?? 600) * 1000;
      const resolutionBreached = now - ticket.createdAt.getTime() > (ticket.pool?.resolutionTargetSeconds ?? 3600) * 1000;
      return responseBreached || resolutionBreached;
    }).length;
    const statusCounts = Object.fromEntries(statusGroups.map((group) => [group.status.toLowerCase(), group._count._all]));
    const scopedEventIds = query.eventId ? [query.eventId] : scope.eventIds;
    const createdFrom = where.createdAt && typeof where.createdAt === 'object' && 'gte' in where.createdAt ? where.createdAt.gte : undefined;
    const createdTo = where.createdAt && typeof where.createdAt === 'object' && 'lte' in where.createdAt ? where.createdAt.lte : undefined;
    const ticketScope = scopedEventIds.length
      ? Prisma.sql`t."eventId" IN (${Prisma.join(scopedEventIds)})`
      : Prisma.sql`FALSE`;
    const hallScope = scope.role === 'HALL_MANAGER' && scope.hallIds.length
      ? Prisma.sql`AND t."hallId" IN (${Prisma.join(scope.hallIds)})`
      : Prisma.empty;
    const dateScope = Prisma.sql`${createdFrom ? Prisma.sql`AND t."createdAt" >= ${createdFrom}` : Prisma.empty}${createdTo ? Prisma.sql`AND t."createdAt" <= ${createdTo}` : Prisma.empty}`;
    const emptyBreakdown = scopedEventIds.length === 0 || (scope.role === 'HALL_MANAGER' && scope.hallIds.length === 0);
    const [rates, durations, categoryGroups, halls, workforceLoad, oldestQueued, oldestAccepted, oldestInProgress] = emptyBreakdown
      ? [{ total: 0, reopened: 0, complained: 0 }, { avgResponseSeconds: null, avgResolutionSeconds: null, medianResponseSeconds: null, p90ResponseSeconds: null, medianResolutionSeconds: null, p90ResolutionSeconds: null }, [], [], [], null, null, null]
      : await Promise.all([
        this.prisma.ticket.aggregate({
          where: { ...where, status: { not: 'CANCELLED' } },
          _count: { _all: true },
        }).then(async (total) => {
          const [reopened, complained] = await Promise.all([
            this.prisma.ticket.count({ where: { ...where, reopenCount: { gt: 0 }, status: { not: 'CANCELLED' } } }),
            this.prisma.ticket.count({ where: { ...where, status: { not: 'CANCELLED' }, complaints: { some: {} } } }),
          ]);
          return { total: total._count._all, reopened, complained };
        }),
        this.prisma.$queryRaw<Array<{
          avgResponseSeconds: number | null;
          avgResolutionSeconds: number | null;
          medianResponseSeconds: number | null;
          p90ResponseSeconds: number | null;
          medianResolutionSeconds: number | null;
          p90ResolutionSeconds: number | null;
        }>>(Prisma.sql`
          SELECT
            (AVG(EXTRACT(EPOCH FROM (t."firstAcceptedAt" - t."createdAt"))) FILTER (WHERE t."firstAcceptedAt" IS NOT NULL))::double precision AS "avgResponseSeconds",
            (AVG(EXTRACT(EPOCH FROM (t."closedAt" - t."createdAt"))) FILTER (WHERE t.status = 'CLOSED' AND t."closedAt" IS NOT NULL))::double precision AS "avgResolutionSeconds",
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstAcceptedAt" - t."createdAt"))) FILTER (WHERE t."firstAcceptedAt" IS NOT NULL))::double precision AS "medianResponseSeconds",
            (percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."firstAcceptedAt" - t."createdAt"))) FILTER (WHERE t."firstAcceptedAt" IS NOT NULL))::double precision AS "p90ResponseSeconds",
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."closedAt" - t."createdAt"))) FILTER (WHERE t.status = 'CLOSED' AND t."closedAt" IS NOT NULL))::double precision AS "medianResolutionSeconds",
            (percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t."closedAt" - t."createdAt"))) FILTER (WHERE t.status = 'CLOSED' AND t."closedAt" IS NOT NULL))::double precision AS "p90ResolutionSeconds"
          FROM "Ticket" t
          WHERE ${ticketScope} ${hallScope} ${dateScope}
        `).then((rows) => rows[0] ?? {
          avgResponseSeconds: null,
          avgResolutionSeconds: null,
          medianResponseSeconds: null,
          p90ResponseSeconds: null,
          medianResolutionSeconds: null,
          p90ResolutionSeconds: null,
        }),
        this.prisma.ticket.groupBy({
          by: ['category'],
          where: { ...where, status: { notIn: ['CLOSED', 'CANCELLED'] } },
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<Array<{ id: string; code: string; name: string; open: number; queued: number; overdue: number; escalated: number }>>(Prisma.sql`
          SELECT
            h.id,
            h.code,
            h.name,
            COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('CLOSED', 'CANCELLED'))::int AS open,
            COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'QUEUED')::int AS queued,
            COUNT(DISTINCT t.id) FILTER (WHERE a.status::text IN ('ACTIVE', 'ACCEPTED') AND a."responseOverdueAt" IS NOT NULL)::int AS overdue,
            COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'ESCALATED')::int AS escalated
          FROM "Hall" h
          LEFT JOIN "Ticket" t ON t."hallId" = h.id AND t."eventId" = h."eventId" ${createdFrom ? Prisma.sql`AND t."createdAt" >= ${createdFrom}` : Prisma.empty} ${createdTo ? Prisma.sql`AND t."createdAt" <= ${createdTo}` : Prisma.empty}
          LEFT JOIN "Assignment" a ON a."ticketId" = t.id
          WHERE h."eventId" IN (${Prisma.join(scopedEventIds)})
            ${scope.role === 'HALL_MANAGER' ? Prisma.sql`AND h.id IN (${Prisma.join(scope.hallIds)})` : Prisma.empty}
          GROUP BY h.id, h.code, h.name
          ORDER BY h.code ASC
        `),
        this.prisma.$queryRaw<Array<{ hallCode: string; category: string; onDuty: number; paused: number; offDuty: number; capacity: number; active: number }>>(Prisma.sql`
          SELECT
            COALESCE(h.code, 'EVENT') AS "hallCode",
            sp.category,
            COUNT(DISTINCT wm."userId") FILTER (WHERE wm.availability::text = 'ON_DUTY' AND u.status::text = 'ACTIVE' AND u."approvalStatus"::text = 'APPROVED')::int AS "onDuty",
            COUNT(DISTINCT wm."userId") FILTER (WHERE wm.availability::text = 'PAUSED' AND u.status::text = 'ACTIVE' AND u."approvalStatus"::text = 'APPROVED')::int AS paused,
            COUNT(DISTINCT wm."userId") FILTER (WHERE wm.availability::text IN ('OFF_DUTY', 'OFFLINE') AND u.status::text = 'ACTIVE' AND u."approvalStatus"::text = 'APPROVED')::int AS "offDuty",
            COALESCE(SUM(wm.capacity) FILTER (WHERE wm.availability::text = 'ON_DUTY' AND u.status::text = 'ACTIVE' AND u."approvalStatus"::text = 'APPROVED'), 0)::int AS capacity,
            COALESCE(SUM(load.active) FILTER (WHERE wm.availability::text = 'ON_DUTY' AND u.status::text = 'ACTIVE' AND u."approvalStatus"::text = 'APPROVED'), 0)::int AS active
          FROM "WorkforceMembership" wm
          JOIN "ServicePool" sp ON sp.id = wm."poolId"
          JOIN "User" u ON u.id = wm."userId"
          LEFT JOIN "Hall" h ON h.id = sp."hallId"
          LEFT JOIN LATERAL (
            SELECT COUNT(DISTINCT at.id)::int AS active
            FROM "Assignment" asn
            JOIN "Ticket" at ON at.id = asn."ticketId" AND at."poolId" = wm."poolId"
            WHERE asn."staffId" = wm."userId" AND asn.status::text IN ('ACTIVE', 'ACCEPTED')
          ) load ON true
          WHERE wm."eventId" IN (${Prisma.join(scopedEventIds)})
            ${scope.role === 'HALL_MANAGER' ? Prisma.sql`AND sp."hallId" IN (${Prisma.join(scope.hallIds)})` : Prisma.empty}
          GROUP BY h.code, sp.category
          ORDER BY h.code ASC, sp.category ASC
        `),
        this.prisma.ticket.findFirst({
          where: { ...where, status: { in: ['NEW', 'QUEUED'] } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.ticket.findFirst({
          where: { ...where, status: 'ACCEPTED' },
          orderBy: { firstAcceptedAt: 'asc' },
          select: { firstAcceptedAt: true },
        }),
        this.prisma.ticket.findFirst({
          where: { ...where, status: 'IN_PROGRESS' },
          orderBy: { firstStartedAt: 'asc' },
          select: { firstStartedAt: true },
        }),
      ]);
    const seconds = (value: number | null | undefined) => value == null || Number.isNaN(Number(value)) ? null : Math.floor(Number(value));
    const ageSeconds = (value: Date | null | undefined) => value ? Math.floor((now - value.getTime()) / 1000) : null;
    const onDutyCapacity = workforceLoad.reduce((sum, row) => sum + Number(row.capacity), 0);
    const onDutyActive = workforceLoad.reduce((sum, row) => sum + Number(row.active), 0);
    return {
      open: openTickets.length,
      queued,
      overdue,
      escalated,
      complaints,
      closedToday,
      slaBreached,
      oldestOutstandingSeconds: openTickets.length ? Math.floor((now - Math.min(...openTickets.map((ticket) => ticket.createdAt.getTime()))) / 1000) : null,
      avgResponseSeconds: seconds(durations.avgResponseSeconds),
      avgResolutionSeconds: seconds(durations.avgResolutionSeconds),
      medianResponseSeconds: seconds(durations.medianResponseSeconds),
      p90ResponseSeconds: seconds(durations.p90ResponseSeconds),
      medianResolutionSeconds: seconds(durations.medianResolutionSeconds),
      p90ResolutionSeconds: seconds(durations.p90ResolutionSeconds),
      reopenRate: rates.total ? rates.reopened / rates.total : null,
      complaintRate: rates.total ? rates.complained / rates.total : null,
      staffUtilization: onDutyCapacity ? onDutyActive / onDutyCapacity : null,
      oldestQueuedSeconds: ageSeconds(oldestQueued?.createdAt),
      oldestAcceptedSeconds: ageSeconds(oldestAccepted?.firstAcceptedAt),
      oldestInProgressSeconds: ageSeconds(oldestInProgress?.firstStartedAt),
      categoryBacklog: categoryGroups.map((group) => ({ category: group.category, open: group._count._all })),
      halls: halls.map((hall) => ({
        ...hall,
        open: Number(hall.open),
        queued: Number(hall.queued),
        overdue: Number(hall.overdue),
        escalated: Number(hall.escalated),
      })),
      workforceLoad: workforceLoad.map((row) => ({
        hallCode: row.hallCode,
        category: row.category,
        onDuty: Number(row.onDuty),
        paused: Number(row.paused),
        offDuty: Number(row.offDuty),
        capacity: Number(row.capacity),
        active: Number(row.active),
      })),
      ...statusCounts,
    };
  }

  async timing(scope: AuthScope) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    const tickets = await this.prisma.ticket.findMany({
      where: {
        eventId: { in: scope.eventIds },
        ...(scope.role === 'HALL_MANAGER' ? { hallId: { in: scope.hallIds } } : {}),
      },
      include: {
        event: { select: { timezone: true } },
        assignments: { orderBy: { assignedAt: 'asc' } },
        otpChallenges: { orderBy: { createdAt: 'asc' } },
        events: { where: { eventType: { in: ['TICKET_QUEUED', 'ASSIGNMENT_CREATED', 'ASSIGNMENT_REASSIGNED', 'OTP_VERIFIED', 'OVERRIDE_CLOSED'] } }, orderBy: { createdAt: 'asc' } },
      },
      take: 1000,
      orderBy: { createdAt: 'desc' },
    });
    const nowMs = Date.now();
    return tickets.map((ticket) => {
      const latestAssignment = ticket.assignments.at(-1);
      const queueCycles = ticket.events
        .filter((event) => event.eventType === 'TICKET_QUEUED')
        .map((queuedEvent, index) => {
          const assignedEvent = ticket.events.find((event) =>
            ['ASSIGNMENT_CREATED', 'ASSIGNMENT_REASSIGNED'].includes(event.eventType) &&
            event.createdAt >= queuedEvent.createdAt,
          );
          return {
            attempt: index + 1,
            queuedAt: queuedEvent.createdAt,
            assignedAt: assignedEvent?.createdAt ?? null,
            waitSeconds: assignedEvent ? Math.max(0, Math.floor((assignedEvent.createdAt.getTime() - queuedEvent.createdAt.getTime()) / 1000)) : null,
          };
        });
      return {
      id: ticket.id,
      publicNo: ticket.publicNo,
      eventTimezone: ticket.event.timezone,
      createdAt: ticket.createdAt,
      firstAssignedAt: ticket.firstAssignedAt,
      firstAcceptedAt: ticket.firstAcceptedAt,
      firstStartedAt: ticket.firstStartedAt,
      completionRequestedAt: ticket.completionRequestedAt,
      closedAt: ticket.closedAt,
      raiseToAssignSeconds: ticket.firstAssignedAt ? Math.floor((ticket.firstAssignedAt.getTime() - ticket.createdAt.getTime()) / 1000) : null,
      queueWaitSeconds: queueCycles.some((cycle) => cycle.waitSeconds != null)
        ? queueCycles.reduce((sum, cycle) => sum + (cycle.waitSeconds ?? 0), 0)
        : null,
      assignToAcceptSeconds: ticket.firstAssignedAt && ticket.firstAcceptedAt ? Math.floor((ticket.firstAcceptedAt.getTime() - ticket.firstAssignedAt.getTime()) / 1000) : null,
      mobilizationSeconds: ticket.firstAcceptedAt && ticket.firstStartedAt ? Math.floor((ticket.firstStartedAt.getTime() - ticket.firstAcceptedAt.getTime()) / 1000) : null,
      activeWorkSeconds: latestAssignment?.startedAt && latestAssignment.completionRequestedAt ? Math.floor((latestAssignment.completionRequestedAt.getTime() - latestAssignment.startedAt.getTime()) / 1000) : null,
      otpWaitSeconds: ticket.status === 'CLOSED' && ticket.completionRequestedAt && ticket.closedAt ? Math.floor((ticket.closedAt.getTime() - ticket.completionRequestedAt.getTime()) / 1000) : null,
      totalResolutionSeconds: closedResolutionSeconds(ticket.status, ticket.createdAt, ticket.closedAt),
      liveAgeSeconds: displayLiveAgeSeconds(ticket.status, ticket.createdAt, nowMs),
      currentStageAgeSeconds: ticket.status === 'CLOSED' || ticket.status === 'CANCELLED' ? null : boundedElapsedSeconds(
        latestAssignment?.completionRequestedAt ??
        latestAssignment?.startedAt ??
        latestAssignment?.acceptedAt ??
        latestAssignment?.assignedAt ??
        ticket.queuedAt ??
        ticket.createdAt,
        nowMs,
      ),
      queueCycles,
      workCycles: ticket.assignments.map((assignment, index) => {
        const nextAssignment = ticket.assignments[index + 1];
        const closure = ticket.otpChallenges.find((challenge) =>
          challenge.verifiedAt &&
          (!assignment.completionRequestedAt || challenge.createdAt >= assignment.completionRequestedAt) &&
          (!nextAssignment || challenge.createdAt < nextAssignment.assignedAt),
        );
        const overrideClosure = ticket.events.find((event) =>
          event.eventType === 'OVERRIDE_CLOSED' &&
          event.createdAt >= assignment.assignedAt &&
          (!nextAssignment || event.createdAt < nextAssignment.assignedAt),
        );
        const cycleClosedAt = closure?.verifiedAt ?? overrideClosure?.createdAt ?? null;
        return {
          attempt: index + 1,
          assignedAt: assignment.assignedAt,
          acceptedAt: assignment.acceptedAt,
          startedAt: assignment.startedAt,
          completionRequestedAt: assignment.completionRequestedAt,
          closedAt: cycleClosedAt,
          releasedAt: assignment.releasedAt,
          releaseReason: assignment.releaseReason,
          responseSeconds: assignment.acceptedAt ? Math.floor((assignment.acceptedAt.getTime() - assignment.assignedAt.getTime()) / 1000) : null,
          mobilizationSeconds: assignment.acceptedAt && assignment.startedAt ? Math.floor((assignment.startedAt.getTime() - assignment.acceptedAt.getTime()) / 1000) : null,
          activeWorkSeconds: assignment.startedAt && assignment.completionRequestedAt ? Math.floor((assignment.completionRequestedAt.getTime() - assignment.startedAt.getTime()) / 1000) : null,
          otpWaitSeconds: assignment.completionRequestedAt && cycleClosedAt ? Math.floor((cycleClosedAt.getTime() - assignment.completionRequestedAt.getTime()) / 1000) : null,
        };
      }),
    };
    });
  }

  async portfolio(scope: AuthScope) {
    requireAuthority(scope.role, 'SUPER_ADMIN');
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      event: string;
      venue: string;
      status: string;
      open: bigint;
      exceptions: bigint;
      avgResponseSeconds: number | null;
      medianResponseSeconds: number | null;
      portfolioMedianResponseSeconds: number | null;
    }>>(Prisma.sql`
      WITH global_response AS (
        SELECT percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (t."firstAcceptedAt" - t."createdAt"))
        )::double precision AS median
        FROM "Ticket" t
        WHERE t."eventId" IN (${Prisma.join(scope.eventIds)})
          AND t."firstAcceptedAt" IS NOT NULL
      )
      SELECT
        e.id,
        e.name AS event,
        e.venue,
        e.status::text AS status,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('CLOSED', 'CANCELLED')) AS open,
        COUNT(t.id) FILTER (WHERE t.status IN ('ESCALATED', 'COMPLAINT_RAISED')) AS exceptions,
        (AVG(EXTRACT(EPOCH FROM (t."firstAcceptedAt" - t."createdAt")))
          FILTER (WHERE t."firstAcceptedAt" IS NOT NULL))::double precision AS "avgResponseSeconds",
        (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (t."firstAcceptedAt" - t."createdAt"))
        ) FILTER (WHERE t."firstAcceptedAt" IS NOT NULL))::double precision AS "medianResponseSeconds",
        global_response.median AS "portfolioMedianResponseSeconds"
      FROM "Event" e
      CROSS JOIN global_response
      LEFT JOIN "Ticket" t ON t."eventId" = e.id
      WHERE e.id IN (${Prisma.join(scope.eventIds)})
      GROUP BY e.id, e.name, e.venue, e.status, e."startsAt", global_response.median
      ORDER BY e."startsAt" DESC
    `);
    return rows.map((row) => ({
      ...row,
      open: Number(row.open),
      exceptions: Number(row.exceptions),
      avgResponseSeconds: row.avgResponseSeconds == null ? null : Math.floor(row.avgResponseSeconds),
      medianResponseSeconds: row.medianResponseSeconds == null ? null : Math.floor(row.medianResponseSeconds),
      portfolioMedianResponseSeconds: row.portfolioMedianResponseSeconds == null ? null : Math.floor(row.portfolioMedianResponseSeconds),
    }));
  }

  async exceptions(scope: AuthScope) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    const where = {
      eventId: { in: scope.eventIds },
      ...(scope.role === 'HALL_MANAGER' ? { hallId: { in: scope.hallIds } } : {}),
    };
    return this.prisma.ticket.findMany({
      where: {
        ...where,
        OR: [
          { status: { in: ['QUEUED', 'COMPLAINT_RAISED', 'ESCALATED', 'REOPENED'] } },
          { complaints: { some: { resolution: null } } },
          { assignments: { some: { responseOverdueAt: { not: null }, status: { in: ['ACTIVE', 'ACCEPTED'] } } } },
        ],
      },
      include: { hall: true, zone: true, stall: true, assignments: { where: { status: { in: ['ACTIVE', 'ACCEPTED'] } }, include: { staff: { select: { name: true } } } } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 100,
    });
  }

  async audit(scope: AuthScope, query: { action?: string; ticket?: string }) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    const ticketEvents = await this.prisma.ticketEvent.findMany({
      where: {
        eventId: { in: scope.eventIds },
        AND: [
          ...(scope.role === 'HALL_MANAGER' ? [{ ticket: { hallId: { in: scope.hallIds } } }] : []),
          ...(query.ticket ? [{ ticket: { publicNo: { contains: query.ticket, mode: 'insensitive' as const } } }] : []),
        ],
        ...(query.action ? { eventType: { contains: query.action, mode: 'insensitive' as const } } : {}),
      },
      include: { actor: { select: { name: true, role: true } }, ticket: { select: { publicNo: true, hallId: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (!['ADMIN', 'SUPER_ADMIN'].includes(scope.role)) return ticketEvents;
    const managementAudits = await this.prisma.managementAudit.findMany({
      where: {
        OR: [
          { eventId: { in: scope.eventIds } },
          { eventId: null, organizationId: (await this.prisma.user.findUniqueOrThrow({ where: { id: scope.userId }, select: { organizationId: true } })).organizationId },
        ],
        ...(query.action ? { action: { contains: query.action, mode: 'insensitive' as const } } : {}),
      },
      include: {
        actor: { select: { name: true, role: true } },
        targetUser: { select: { name: true, employeeCode: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return [
      ...ticketEvents.map((event) => ({
        id: event.id,
        kind: 'ticket' as const,
        eventType: event.eventType,
        createdAt: event.createdAt,
        actor: event.actor,
        ticket: event.ticket,
        target: null as null,
      })),
      ...managementAudits.map((event) => ({
        id: event.id,
        kind: 'workforce' as const,
        eventType: event.action,
        createdAt: event.createdAt,
        actor: event.actor,
        ticket: { publicNo: event.targetUser?.role === 'STALL' ? 'Stall account' : (event.targetUser?.employeeCode ?? event.targetUser?.name ?? 'Account') },
        target: event.targetUser,
      })),
    ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).slice(0, 200);
  }

  async masters(scope: AuthScope) {
    requireAuthority(scope.role, 'ADMIN');
    const events = await this.prisma.event.findMany({
      where: { id: { in: scope.eventIds } },
      include: {
        halls: { include: { zones: { include: { stalls: true } } } },
        pools: { orderBy: [{ category: 'asc' }, { subtype: 'asc' }] },
      },
      orderBy: { startsAt: 'desc' },
    });
    return events;
  }

  async updatePool(scope: AuthScope, id: string, body: UpdatePoolDto) {
    requireAuthority(scope.role, 'ADMIN');
    const pool = await this.prisma.servicePool.findUniqueOrThrow({ where: { id } });
    if (!scope.eventIds.includes(pool.eventId)) throw new NotFoundException('Service pool is unavailable');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.servicePool.update({
        where: { id },
        data: { responseTargetSeconds: body.responseTargetSeconds, resolutionTargetSeconds: body.resolutionTargetSeconds, ...(typeof body.active === 'boolean' ? { active: body.active } : {}) },
      });
      await tx.outboxEvent.create({
        data: {
          eventId: pool.eventId,
          aggregateType: 'ServicePool',
          aggregateId: id,
          eventType: 'SERVICE_POOL_UPDATED',
          payload: { actorId: scope.userId, before: pool, after: updated },
        },
      });
      return updated;
    });
  }

  async createMaster(scope: AuthScope, type: 'hall' | 'zone' | 'stall', body: CreateMasterBodyDto) {
    requireAuthority(scope.role, 'ADMIN');
    const eventId = body.eventId;
    if (!scope.eventIds.includes(eventId)) throw new NotFoundException('Event is unavailable');
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({ where: { id: eventId }, select: { status: true } });
      if (!event || ['CLOSED', 'ARCHIVED'].includes(event.status)) throw new BadRequestException('Master data cannot be added to a completed event');
      let created: object & { id: string };
      if (type === 'hall') {
        const code = (body.code ?? '').trim();
        const name = (body.name ?? '').trim();
        if (!code || !name) throw new BadRequestException('Hall code and name are required');
        created = await tx.hall.create({
          data: {
            eventId,
            code,
            name,
            active: body.status !== 'INACTIVE',
          },
        });
      } else if (type === 'zone') {
        const hallId = body.hallId ?? '';
        const code = (body.code ?? '').trim();
        const hall = await tx.hall.findFirst({ where: { id: hallId, eventId, active: true } });
        if (!hall || !code) throw new BadRequestException('Valid hall and zone code are required');
        created = await tx.zone.create({ data: { eventId, hallId, code } });
      } else {
        const zoneId = body.zoneId ?? '';
        const stallCode = (body.stallCode ?? '').trim();
        const exhibitorName = (body.exhibitorName ?? '').trim();
        const zone = await tx.zone.findFirst({ where: { id: zoneId, eventId, active: true, hall: { active: true } } });
        if (!zone || !stallCode || !exhibitorName) throw new BadRequestException('Valid zone, stall code, and exhibitor name are required');
        created = await tx.stall.create({
          data: {
            eventId,
            zoneId,
            stallCode,
            exhibitorName,
            contact: body.contact?.trim() || null,
            servicePriority: body.servicePriority ?? 'MEDIUM',
            active: body.active !== false,
          },
        });
      }
      await tx.outboxEvent.create({
        data: {
          eventId,
          aggregateType: type.toUpperCase(),
          aggregateId: created.id,
          eventType: `${type.toUpperCase()}_CREATED`,
          payload: { actorId: scope.userId, created },
        },
      });
      return created;
    }).catch((error: unknown) => {
      const message = type === 'stall' ? stallCodeConflictMessage(error, body.stallCode ?? '') : null;
      if (message) throw new ConflictException(message);
      throw error;
    });
  }

  async registrations(scope: AuthScope) {
    requireAuthority(scope.role, 'ADMIN');
    const stalls = await this.prisma.stall.findMany({
      where: { eventId: { in: scope.eventIds } },
      include: {
        zone: { include: { hall: { select: { id: true, code: true, name: true } } } },
        scopes: {
          where: { user: { role: 'STALL' } },
          select: { user: { select: { id: true, name: true, email: true, status: true, role: true, mustChangePassword: true } } },
        },
        _count: { select: { tickets: { where: { status: { in: [...ACTIVE_TICKET_STATUSES] } } } } },
      },
      orderBy: [{ zone: { hall: { name: 'asc' } } }, { stallCode: 'asc' }],
    });
    return stalls.map((stall) => ({
      id: stall.id,
      eventId: stall.eventId,
      stallCode: stall.stallCode,
      exhibitorName: stall.exhibitorName,
      contact: stall.contact,
      servicePriority: stall.servicePriority,
      active: stall.active,
      archivedAt: stall.archivedAt,
      openTicketCount: stall._count.tickets,
      zone: { id: stall.zone.id, code: stall.zone.code, hall: stall.zone.hall },
      exhibitors: stall.scopes.map((scopeRow) => scopeRow.user),
    }));
  }

  async updateRegistration(scope: AuthScope, stallId: string, body: UpdateRegistrationDto) {
    requireAuthority(scope.role, 'ADMIN');
    const stall = await this.requireStall(scope, stallId);
    if (stall.archivedAt) throw new BadRequestException('Archived registrations cannot be edited');
    const stallCode = body.stallCode?.trim();
    const exhibitorName = body.exhibitorName?.trim();
    if (body.stallCode !== undefined && !stallCode) throw new BadRequestException('Stall code is required');
    if (body.exhibitorName !== undefined && !exhibitorName) throw new BadRequestException('Exhibitor name is required');
    if (stallCode === undefined && exhibitorName === undefined && body.contact === undefined && !body.servicePriority) {
      throw new BadRequestException('Nothing to update');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockStalls(tx, [stall.id]);
        const current = await tx.stall.findUniqueOrThrow({ where: { id: stall.id } });
        if (current.archivedAt) throw new BadRequestException('Archived registrations cannot be edited');
        const updated = await tx.stall.update({
          where: { id: stall.id },
          data: {
            ...(stallCode ? { stallCode } : {}),
            ...(exhibitorName ? { exhibitorName } : {}),
            ...(body.contact !== undefined ? { contact: body.contact.trim() || null } : {}),
            ...(body.servicePriority ? { servicePriority: body.servicePriority } : {}),
          },
        });
        await this.writeRegistrationAudit(tx, scope, stall.eventId, 'REGISTRATION_UPDATED', {
          stallId: stall.id,
          before: {
            stallCode: current.stallCode,
            exhibitorName: current.exhibitorName,
            contact: current.contact,
            servicePriority: current.servicePriority,
          },
          after: {
            stallCode: updated.stallCode,
            exhibitorName: updated.exhibitorName,
            contact: updated.contact,
            servicePriority: updated.servicePriority,
          },
        });
        return updated;
      });
    } catch (error) {
      const message = stallCodeConflictMessage(error, stallCode ?? '');
      if (message) throw new ConflictException(message);
      throw error;
    }
  }

  async transferExhibitor(scope: AuthScope, stallId: string, body: TransferRegistrationDto) {
    requireAuthority(scope.role, 'ADMIN');
    const reason = body.reason.trim();
    if (reason.length < 3) throw new BadRequestException('A transfer reason is required');
    if (body.destinationStallId === stallId) throw new BadRequestException('Choose a different stall');
    const source = await this.requireStall(scope, stallId);
    const destination = await this.requireStall(scope, body.destinationStallId);
    if (source.eventId !== destination.eventId) throw new BadRequestException('Exhibitor transfer must stay inside the same event');
    if (source.archivedAt || destination.archivedAt || !destination.active) {
      throw new BadRequestException('Transfer requires an active destination registration');
    }
    await this.assertNoUnresolvedWork(source.id, 'Transfer');
    await this.assertNoUnresolvedWork(destination.id, 'Transfer onto');
    return this.prisma.$transaction(async (tx) => {
      await this.lockStalls(tx, [source.id, destination.id]);
      const sourceRow = await tx.stall.findUniqueOrThrow({
        where: { id: source.id },
        include: { zone: { select: { hallId: true } } },
      });
      const destinationRow = await tx.stall.findUniqueOrThrow({
        where: { id: destination.id },
        include: { zone: { select: { hallId: true } } },
      });
      if (sourceRow.eventId !== destinationRow.eventId) throw new BadRequestException('Exhibitor transfer must stay inside the same event');
      if (sourceRow.archivedAt || destinationRow.archivedAt || !destinationRow.active) {
        throw new BadRequestException('Transfer requires an active destination registration');
      }
      await this.assertNoUnresolvedWork(sourceRow.id, 'Transfer', tx);
      await this.assertNoUnresolvedWork(destinationRow.id, 'Transfer onto', tx);
      const exhibitors = await tx.userScope.findMany({
        where: { stallId: sourceRow.id, user: { role: 'STALL' } },
        select: { userId: true },
      });
      if (!exhibitors.length) throw new BadRequestException('This registration has no exhibitor account to transfer');
      const destinationTaken = await tx.userScope.count({
        where: { stallId: destinationRow.id, user: { role: 'STALL' } },
      });
      if (destinationTaken) throw new ConflictException('The destination stall already has an exhibitor account');
      const userIds = exhibitors.map((row) => row.userId);
      await tx.userScope.updateMany({
        where: { stallId: sourceRow.id, userId: { in: userIds } },
        data: { stallId: destinationRow.id, hallId: destinationRow.zone.hallId, eventId: destinationRow.eventId },
      });
      await tx.session.deleteMany({ where: { userId: { in: userIds } } });
      const previousDestination = {
        exhibitorName: destinationRow.exhibitorName,
        contact: destinationRow.contact,
      };
      await tx.stall.update({
        where: { id: destinationRow.id },
        data: { exhibitorName: sourceRow.exhibitorName, contact: sourceRow.contact },
      });
      await tx.stall.update({
        where: { id: sourceRow.id },
        data: { contact: null },
      });
      await this.writeRegistrationAudit(tx, scope, sourceRow.eventId, 'EXHIBITOR_TRANSFERRED', {
        reason,
        userIds,
        sourceStallId: sourceRow.id,
        sourceStallCode: sourceRow.stallCode,
        destinationStallId: destinationRow.id,
        destinationStallCode: destinationRow.stallCode,
        previousDestination,
      });
      return { transferred: true, userIds, sourceStallId: sourceRow.id, destinationStallId: destinationRow.id };
    });
  }

  async archiveRegistration(scope: AuthScope, stallId: string, body: ArchiveRegistrationDto) {
    requireAuthority(scope.role, 'ADMIN');
    const reason = body.reason.trim();
    if (reason.length < 3) throw new BadRequestException('An archive reason is required');
    const stall = await this.requireStall(scope, stallId);
    if (stall.archivedAt) throw new BadRequestException('This registration is already archived');
    await this.assertNoUnresolvedWork(stall.id, 'Archive');
    return this.prisma.$transaction(async (tx) => {
      await this.lockStalls(tx, [stall.id]);
      const current = await tx.stall.findUniqueOrThrow({ where: { id: stall.id } });
      if (current.archivedAt) throw new BadRequestException('This registration is already archived');
      await this.assertNoUnresolvedWork(current.id, 'Archive', tx);
      const exhibitors = await tx.userScope.findMany({
        where: { stallId: current.id, user: { role: 'STALL' } },
        select: { userId: true },
      });
      const userIds = exhibitors.map((row) => row.userId);
      if (userIds.length) {
        await tx.userScope.deleteMany({ where: { stallId: current.id, userId: { in: userIds } } });
        await this.revokeExhibitorsWhoLostAccess(tx, userIds);
      }
      const archived = await tx.stall.update({
        where: { id: current.id },
        data: { active: false, archivedAt: new Date(), contact: null },
      });
      await this.writeRegistrationAudit(tx, scope, current.eventId, 'REGISTRATION_ARCHIVED', {
        reason,
        stallId: current.id,
        stallCode: current.stallCode,
        revokedUserIds: userIds,
      });
      return archived;
    });
  }

  private async requireStall(scope: AuthScope, stallId: string) {
    const stall = await this.prisma.stall.findUnique({
      where: { id: stallId },
      include: { zone: { select: { hallId: true } } },
    });
    if (!stall || !scope.eventIds.includes(stall.eventId)) throw new NotFoundException('Registration is unavailable');
    return stall;
  }

  private async assertNoUnresolvedWork(stallId: string, action: string, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    const open = await tx.ticket.count({
      where: { stallId, status: { in: [...ACTIVE_TICKET_STATUSES] } },
    });
    if (open > 0) {
      throw new ConflictException(`${action} is blocked while this stall has unresolved tickets`);
    }
  }

  /**
   * Archive drops only the stall scope. Sessions and push subscriptions go with an account
   * that has no scope left. An account that still belongs to another stall keeps both.
   * Repeated calls are safe: empty deletes and an already-disabled account are no-ops.
   */
  private async revokeExhibitorsWhoLostAccess(tx: Prisma.TransactionClient, userIds: string[]) {
    const remaining = await tx.userScope.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
    });
    const stillScoped = new Set(remaining.map((row) => row.userId));
    const toDisable = userIds.filter((userId) => !stillScoped.has(userId));
    if (!toDisable.length) return;
    await tx.session.deleteMany({ where: { userId: { in: toDisable } } });
    await tx.pushSubscription.deleteMany({ where: { userId: { in: toDisable } } });
    await tx.user.updateMany({
      where: { id: { in: toDisable }, role: 'STALL', status: { not: 'DISABLED' } },
      data: { status: 'DISABLED' },
    });
  }

  private async lockStalls(tx: Prisma.TransactionClient, stallIds: string[]) {
    for (const stallId of [...new Set(stallIds)].sort()) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM "Stall" WHERE id = ${stallId} FOR UPDATE`);
      if (!rows.length) throw new NotFoundException('Registration is unavailable');
    }
  }

  private async writeRegistrationAudit(
    tx: Prisma.TransactionClient,
    scope: AuthScope,
    eventId: string,
    action: string,
    metadata: Prisma.InputJsonObject,
    targetUserId?: string,
  ) {
    const actor = await tx.user.findUniqueOrThrow({ where: { id: scope.userId }, select: { organizationId: true } });
    await tx.managementAudit.create({
      data: {
        organizationId: actor.organizationId,
        eventId,
        actorId: scope.userId,
        ...(targetUserId ? { targetUserId } : {}),
        action,
        metadata,
      },
    });
    const aggregateId = [metadata.stallId, metadata.sourceStallId].find((value): value is string => typeof value === 'string') ?? eventId;
    await tx.outboxEvent.create({
      data: {
        eventId,
        aggregateType: 'Stall',
        aggregateId,
        eventType: action,
        payload: { actorId: scope.userId, ...metadata },
      },
    });
  }

  async createRegistrationWithLogin(scope: AuthScope, body: CreateRegistrationLoginDto) {
    requireAuthority(scope.role, 'ADMIN');
    if (!scope.eventIds.includes(body.eventId)) throw new NotFoundException('Event is unavailable');
    const stallCode = body.stallCode.trim();
    const exhibitorName = body.exhibitorName.trim();
    const loginName = body.loginName.trim();
    const loginEmail = body.loginEmail.trim().toLowerCase();
    const idempotencyKey = body.idempotencyKey.trim();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'registration-login:' + idempotencyKey}, 0))`);
        const replay = await this.replayRegistrationLogin(tx, scope, idempotencyKey, loginEmail, stallCode);
        if (replay) return replay;
        const zone = await tx.zone.findFirst({
          where: { id: body.zoneId, eventId: body.eventId, active: true, hall: { active: true } },
          include: { hall: { select: { id: true, code: true, name: true } } },
        });
        const event = await tx.event.findUnique({ where: { id: body.eventId }, select: { status: true } });
        if (!zone || !stallCode || !exhibitorName || !event || ['CLOSED', 'ARCHIVED'].includes(event.status)) {
          throw new BadRequestException('A valid active zone, stall, and exhibitor name are required');
        }
        const stall = await tx.stall.create({
          data: {
            eventId: body.eventId,
            zoneId: zone.id,
            stallCode,
            exhibitorName,
            contact: body.contact?.trim() || null,
            servicePriority: body.servicePriority ?? 'MEDIUM',
            active: true,
          },
        });
        const issued = await this.createStallLogin(tx, scope, {
          eventId: stall.eventId,
          hallId: zone.hallId,
          stallId: stall.id,
          stallCode,
          loginName,
          loginEmail,
          idempotencyKey,
          action: 'REGISTRATION_LOGIN_CREATED',
        });
        return {
          created: true,
          credentialIssued: true,
          registration: {
            id: stall.id,
            stallCode: stall.stallCode,
            exhibitorName: stall.exhibitorName,
            servicePriority: stall.servicePriority,
            zone: { id: zone.id, code: zone.code, hall: zone.hall },
          },
          ...issued,
        };
      });
    } catch (error) {
      const message = stallCodeConflictMessage(error, stallCode);
      if (message) throw new ConflictException(message);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That login ID is already in use');
      }
      throw error;
    }
  }

  async createExhibitorLogin(scope: AuthScope, stallId: string, body: CreateExhibitorLoginDto) {
    requireAuthority(scope.role, 'ADMIN');
    const stall = await this.requireStall(scope, stallId);
    if (stall.archivedAt) throw new BadRequestException('Archived registrations cannot receive a new login');
    const loginName = body.loginName.trim();
    const loginEmail = body.loginEmail.trim().toLowerCase();
    const idempotencyKey = body.idempotencyKey.trim();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'exhibitor-login:' + idempotencyKey}, 0))`);
        await this.lockStalls(tx, [stall.id]);
        const current = await tx.stall.findUniqueOrThrow({
          where: { id: stall.id },
          include: { zone: { select: { hallId: true } } },
        });
        if (current.archivedAt || !current.active) throw new BadRequestException('An active registration is required');
        const replay = await this.replayRegistrationLogin(tx, scope, idempotencyKey, loginEmail, current.stallCode);
        if (replay) return replay;
        const issued = await this.createStallLogin(tx, scope, {
          eventId: current.eventId,
          hallId: current.zone.hallId,
          stallId: current.id,
          stallCode: current.stallCode,
          loginName,
          loginEmail,
          idempotencyKey,
          action: 'EXHIBITOR_LOGIN_CREATED',
        });
        return { created: true, credentialIssued: true, ...issued };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That login ID is already in use');
      }
      throw error;
    }
  }

  async resetExhibitorCredential(scope: AuthScope, stallId: string) {
    requireAuthority(scope.role, 'ADMIN');
    const stall = await this.requireStall(scope, stallId);
    if (stall.archivedAt) throw new BadRequestException('Archived registrations cannot be reset');
    return this.prisma.$transaction(async (tx) => {
      await this.lockStalls(tx, [stall.id]);
      const binding = await tx.userScope.findFirst({
        where: { stallId: stall.id, user: { role: 'STALL' } },
        select: { userId: true },
      });
      if (!binding) throw new BadRequestException('This registration has no exhibitor login to reset');
      const initialCredential = randomBytes(18).toString('base64url');
      const user = await tx.user.update({
        where: { id: binding.userId },
        data: { passwordHash: await hash(initialCredential, 12), mustChangePassword: true },
        select: { id: true, name: true, email: true, status: true, mustChangePassword: true },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.pushSubscription.deleteMany({ where: { userId: user.id } });
      await this.writeRegistrationAudit(tx, scope, stall.eventId, 'EXHIBITOR_LOGIN_RESET', {
        stallId: stall.id,
        stallCode: stall.stallCode,
        email: user.email,
        userId: user.id,
      }, user.id);
      return {
        created: false,
        credentialIssued: true,
        account: user,
        handoff: {
          loginPath: '/login',
          email: user.email,
          initialCredential,
          stallCode: stall.stallCode,
          instructions: 'Sign in with this login ID and the new initial password, then set a new password. Earlier sessions for this account are signed out.',
        },
      };
    });
  }

  private async replayRegistrationLogin(
    tx: Prisma.TransactionClient,
    scope: AuthScope,
    idempotencyKey: string,
    loginEmail: string,
    stallCode: string,
  ) {
    const prior = await tx.managementAudit.findFirst({
      where: {
        actorId: scope.userId,
        action: { in: ['REGISTRATION_LOGIN_CREATED', 'EXHIBITOR_LOGIN_CREATED'] },
        metadata: { path: ['idempotencyKey'], equals: idempotencyKey },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!prior?.metadata || typeof prior.metadata !== 'object' || Array.isArray(prior.metadata)) return null;
    const meta = prior.metadata as { email?: string; stallCode?: string; stallId?: string; userId?: string };
    if (meta.email !== loginEmail || meta.stallCode !== stallCode) {
      throw new ConflictException('This registration attempt was already used for a different stall or login');
    }
    const user = meta.userId
      ? await tx.user.findUnique({
        where: { id: meta.userId },
        select: { id: true, name: true, email: true, status: true, mustChangePassword: true },
      })
      : null;
    const stall = meta.stallId
      ? await tx.stall.findUnique({
        where: { id: meta.stallId },
        include: { zone: { include: { hall: { select: { id: true, code: true, name: true } } } } },
      })
      : null;
    if (!user || !stall) {
      throw new ConflictException('This registration attempt already finished, but the login could not be loaded');
    }
    return {
      created: false,
      credentialIssued: false,
      registration: {
        id: stall.id,
        stallCode: stall.stallCode,
        exhibitorName: stall.exhibitorName,
        servicePriority: stall.servicePriority,
        zone: { id: stall.zone.id, code: stall.zone.code, hall: stall.zone.hall },
      },
      account: user,
      handoff: {
        loginPath: '/login',
        email: user.email,
        initialCredential: null as string | null,
        stallCode: stall.stallCode,
        instructions: 'This login already exists. Reset the initial password if the first handoff was lost. The earlier password cannot be shown again.',
      },
    };
  }

  private async createStallLogin(
    tx: Prisma.TransactionClient,
    scope: AuthScope,
    input: {
      eventId: string;
      hallId: string;
      stallId: string;
      stallCode: string;
      loginName: string;
      loginEmail: string;
      idempotencyKey: string;
      action: 'REGISTRATION_LOGIN_CREATED' | 'EXHIBITOR_LOGIN_CREATED';
    },
  ) {
    const occupied = await tx.userScope.count({ where: { stallId: input.stallId, user: { role: 'STALL' } } });
    if (occupied) throw new ConflictException('This stall already has an exhibitor account');
    const actor = await tx.user.findUniqueOrThrow({ where: { id: scope.userId }, select: { organizationId: true } });
    const initialCredential = randomBytes(18).toString('base64url');
    const user = await tx.user.create({
      data: {
        organizationId: actor.organizationId,
        name: input.loginName,
        email: input.loginEmail,
        passwordHash: await hash(initialCredential, 12),
        mustChangePassword: true,
        role: 'STALL',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
        approvedById: scope.userId,
        approvedAt: new Date(),
        scopes: { create: [{ eventId: input.eventId, hallId: input.hallId, stallId: input.stallId }] },
      },
      select: { id: true, name: true, email: true, status: true, mustChangePassword: true },
    });
    await this.writeRegistrationAudit(tx, scope, input.eventId, input.action, {
      stallId: input.stallId,
      stallCode: input.stallCode,
      email: input.loginEmail,
      idempotencyKey: input.idempotencyKey,
      userId: user.id,
    }, user.id);
    return {
      account: user,
      handoff: {
        loginPath: '/login',
        email: user.email,
        initialCredential,
        stallCode: input.stallCode,
        instructions: 'Sign in with this login ID and the initial password, then set a new password before using the stall.',
      },
    };
  }

  async admins(scope: AuthScope) {
    requireAuthority(scope.role, 'SUPER_ADMIN');
    return this.prisma.user.findMany({
      where: { role: 'ADMIN', scopes: { some: { eventId: { in: scope.eventIds } } } },
      select: { id: true, name: true, email: true, status: true, scopes: { select: { event: { select: { id: true, name: true } } } } },
      orderBy: { name: 'asc' },
    });
  }

  async createAdmin(scope: AuthScope, body: CreateAdminDto) {
    requireAuthority(scope.role, 'SUPER_ADMIN');
    const eventIds = [...new Set(body.eventIds)];
    if (eventIds.some((eventId) => !scope.eventIds.includes(eventId))) throw new NotFoundException('Admin event scope is unavailable');
    const actor = await this.prisma.user.findUniqueOrThrow({ where: { id: scope.userId }, select: { organizationId: true } });
    const validEventCount = await this.prisma.event.count({ where: { id: { in: eventIds }, organizationId: actor.organizationId } });
    if (validEventCount !== eventIds.length) throw new NotFoundException('Admin event scope is unavailable');
    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.user.create({
        data: {
          organizationId: actor.organizationId,
          name: body.name.trim(),
          email: body.email.trim().toLowerCase(),
          passwordHash: await hash(body.password, 12),
          mustChangePassword: true,
          role: 'ADMIN',
          scopes: { create: eventIds.map((eventId) => ({ eventId })) },
        },
        select: { id: true, name: true, email: true, status: true, mustChangePassword: true },
      });
      await tx.outboxEvent.createMany({
        data: eventIds.map((eventId) => ({
          eventId,
          aggregateType: 'User',
          aggregateId: admin.id,
          eventType: 'ADMIN_CREATED',
          payload: { actorId: scope.userId, adminId: admin.id, eventIds },
        })),
      });
      return admin;
    });
  }

  async createExport(scope: AuthScope, format: string, filters: unknown, columns: unknown) {
    requireAuthority(scope.role, 'ADMIN');
    const normalizedFormat = String(format).toUpperCase();
    if (!['CSV', 'XLSX'].includes(normalizedFormat)) throw new BadRequestException('Export format must be CSV or XLSX');
    const filterRecord = (filters && typeof filters === 'object' ? filters : {}) as Record<string, unknown>;
    const requested = Array.isArray(filterRecord.eventIds)
      ? filterRecord.eventIds.filter((value): value is string => typeof value === 'string')
      : typeof filterRecord.eventId === 'string'
        ? [filterRecord.eventId]
        : [];
    const eventIds = requested.length ? requested : scope.eventIds;
    if (eventIds.some((eventId) => !scope.eventIds.includes(eventId))) {
      throw new NotFoundException('Export scope is unavailable');
    }
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.exportJob.create({
        data: {
          requestedById: scope.userId,
          eventIds,
          format: normalizedFormat,
          filterSnapshot: filterRecord as Prisma.InputJsonObject,
          visibleColumns: (columns && typeof columns === 'object' ? columns : []) as object,
        },
      });
      await tx.outboxEvent.createMany({
        data: eventIds.map((eventId) => ({
          eventId,
          aggregateType: 'ExportJob',
          aggregateId: job.id,
          eventType: 'EXPORT_REQUESTED',
          payload: { actorId: scope.userId, format: normalizedFormat, filterSnapshot: filterRecord as Prisma.InputJsonObject },
        })),
      });
      return job;
    });
  }

  async exports(scope: AuthScope) {
    requireAuthority(scope.role, 'ADMIN');
    return this.prisma.exportJob.findMany({
      where: { requestedById: scope.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async exportFile(id: string, scope: AuthScope) {
    requireAuthority(scope.role, 'ADMIN');
    const job = await this.prisma.exportJob.findFirst({
      where: { id, requestedById: scope.userId, status: 'READY' },
    });
    if (job?.eventIds.some((eventId) => !scope.eventIds.includes(eventId))) {
      throw new NotFoundException('Export scope is no longer authorized');
    }
    if (!job?.storageKey || (job.expiresAt && job.expiresAt <= new Date())) {
      throw new NotFoundException('Export is unavailable or expired');
    }
    const exportDir = process.env.EXPORT_DIR ?? resolve(process.cwd(), '../../exports');
    const filePath = resolve(exportDir, basename(job.storageKey));
    if (!existsSync(filePath)) throw new NotFoundException('Export file is unavailable');
    await this.prisma.outboxEvent.createMany({
      data: job.eventIds.map((eventId) => ({
        eventId,
        aggregateType: 'ExportJob',
        aggregateId: job.id,
        eventType: 'EXPORT_DOWNLOADED',
        payload: { actorId: scope.userId, downloadedAt: new Date().toISOString() },
      })),
    });
    return { job, filePath };
  }
}

@UseGuards(SessionGuard)
@Controller('management')
export class ManagementController {
  constructor(private readonly service: ManagementService) {}
  @Get('metrics') metrics(@CurrentScope() scope: AuthScope, @Query() query: MetricsQueryDto) { return this.service.metrics(scope, query); }
  @Get('timing') timing(@CurrentScope() scope: AuthScope) { return this.service.timing(scope); }
  @Get('portfolio') portfolio(@CurrentScope() scope: AuthScope) { return this.service.portfolio(scope); }
  @Get('exceptions') exceptions(@CurrentScope() scope: AuthScope) { return this.service.exceptions(scope); }
  @Get('audit') audit(@CurrentScope() scope: AuthScope, @Query() query: AuditQueryDto) { return this.service.audit(scope, query); }
  @Get('masters') masters(@CurrentScope() scope: AuthScope) { return this.service.masters(scope); }
  @Get('registrations') registrations(@CurrentScope() scope: AuthScope) { return this.service.registrations(scope); }
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('registrations/with-login')
  createRegistrationWithLogin(@CurrentScope() scope: AuthScope, @Body() body: CreateRegistrationLoginDto) {
    return this.service.createRegistrationWithLogin(scope, body);
  }
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('registrations/:stallId/exhibitor-login')
  createExhibitorLogin(@Param('stallId') stallId: string, @CurrentScope() scope: AuthScope, @Body() body: CreateExhibitorLoginDto) {
    return this.service.createExhibitorLogin(scope, stallId, body);
  }
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('registrations/:stallId/exhibitor-login/reset')
  resetExhibitorCredential(@Param('stallId') stallId: string, @CurrentScope() scope: AuthScope) {
    return this.service.resetExhibitorCredential(scope, stallId);
  }
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Patch('registrations/:stallId') updateRegistration(@Param('stallId') stallId: string, @CurrentScope() scope: AuthScope, @Body() body: UpdateRegistrationDto) {
    return this.service.updateRegistration(scope, stallId, body);
  }
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('registrations/:stallId/transfer') transferRegistration(@Param('stallId') stallId: string, @CurrentScope() scope: AuthScope, @Body() body: TransferRegistrationDto) {
    return this.service.transferExhibitor(scope, stallId, body);
  }
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('registrations/:stallId/archive') archiveRegistration(@Param('stallId') stallId: string, @CurrentScope() scope: AuthScope, @Body() body: ArchiveRegistrationDto) {
    return this.service.archiveRegistration(scope, stallId, body);
  }
  @Patch('masters/pools/:id') updatePool(@Param('id') id: string, @CurrentScope() scope: AuthScope, @Body() body: UpdatePoolDto) { return this.service.updatePool(scope, id, body); }
  @Post('masters/:type') createMaster(@Param('type') type: 'hall' | 'zone' | 'stall', @CurrentScope() scope: AuthScope, @Body() body: CreateMasterBodyDto) {
    if (!['hall', 'zone', 'stall'].includes(type)) throw new BadRequestException('Unsupported master type');
    return this.service.createMaster(scope, type, body);
  }
  @Get('admins') admins(@CurrentScope() scope: AuthScope) { return this.service.admins(scope); }
  @Post('admins') createAdmin(@CurrentScope() scope: AuthScope, @Body() body: CreateAdminDto) { return this.service.createAdmin(scope, body); }
  @Get('exports') exports(@CurrentScope() scope: AuthScope) { return this.service.exports(scope); }
  @Post('exports') export(@CurrentScope() scope: AuthScope, @Body() body: CreateExportDto) { return this.service.createExport(scope, body.format, body.filters, body.columns); }
  @Get('exports/:id/download')
  async download(
    @Param('id') id: string,
    @CurrentScope() scope: AuthScope,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { job, filePath } = await this.service.exportFile(id, scope);
    response.setHeader('Content-Disposition', 'attachment; filename="eveops-' + job.id + '.' + job.format.toLowerCase() + '"');
    response.setHeader('Content-Type', job.format.toLowerCase() === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv');
    return new StreamableFile(createReadStream(filePath));
  }
}

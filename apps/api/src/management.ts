import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { AuthScope } from '@eveops/contracts';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { createReadStream, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { CurrentScope, SessionGuard } from './auth';
import { requireAuthority } from './domain';
import { PrismaService } from './prisma.service';

@Injectable()
export class ManagementService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(scope: AuthScope) {
    requireAuthority(scope.role, 'HALL_MANAGER');
    const where = { eventId: { in: scope.eventIds }, ...(scope.role === 'HALL_MANAGER' ? { hallId: { in: scope.hallIds } } : {}) };
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
    const responseDurations = openTickets.flatMap((ticket) =>
      ticket.firstAcceptedAt ? [Math.floor((ticket.firstAcceptedAt.getTime() - ticket.createdAt.getTime()) / 1000)] : [],
    );
    const now = Date.now();
    const slaBreached = openTickets.filter((ticket) => {
      const responseBreached = !ticket.firstAcceptedAt && now - ticket.createdAt.getTime() > (ticket.pool?.responseTargetSeconds ?? 600) * 1000;
      const resolutionBreached = now - ticket.createdAt.getTime() > (ticket.pool?.resolutionTargetSeconds ?? 3600) * 1000;
      return responseBreached || resolutionBreached;
    }).length;
    const statusCounts = Object.fromEntries(statusGroups.map((group) => [group.status.toLowerCase(), group._count._all]));
    return {
      open: openTickets.length,
      queued,
      overdue,
      escalated,
      complaints,
      closedToday,
      slaBreached,
      oldestOutstandingSeconds: openTickets.length ? Math.floor((now - Math.min(...openTickets.map((ticket) => ticket.createdAt.getTime()))) / 1000) : null,
      avgResponseSeconds: responseDurations.length ? Math.floor(responseDurations.reduce((sum, value) => sum + value, 0) / responseDurations.length) : null,
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
      otpWaitSeconds: ticket.completionRequestedAt && ticket.closedAt ? Math.floor((ticket.closedAt.getTime() - ticket.completionRequestedAt.getTime()) / 1000) : null,
      totalResolutionSeconds: ticket.closedAt ? Math.floor((ticket.closedAt.getTime() - ticket.createdAt.getTime()) / 1000) : null,
      liveAgeSeconds: Math.floor((Date.now() - ticket.createdAt.getTime()) / 1000),
      currentStageAgeSeconds: Math.floor((Date.now() - (
        latestAssignment?.completionRequestedAt ??
        latestAssignment?.startedAt ??
        latestAssignment?.acceptedAt ??
        latestAssignment?.assignedAt ??
        ticket.queuedAt ??
        ticket.createdAt
      ).getTime()) / 1000),
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
    return this.prisma.ticketEvent.findMany({
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

  async updatePool(scope: AuthScope, id: string, body: { responseTargetSeconds: number; resolutionTargetSeconds: number; active?: boolean }) {
    requireAuthority(scope.role, 'ADMIN');
    if (!Number.isInteger(body.responseTargetSeconds) || body.responseTargetSeconds <= 0 || !Number.isInteger(body.resolutionTargetSeconds) || body.resolutionTargetSeconds <= 0) {
      throw new BadRequestException('SLA targets must be positive whole seconds');
    }
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

  async createMaster(scope: AuthScope, type: 'hall' | 'zone' | 'stall', body: Record<string, unknown>) {
    requireAuthority(scope.role, 'ADMIN');
    const eventId = String(body.eventId ?? '');
    if (!scope.eventIds.includes(eventId)) throw new NotFoundException('Event is unavailable');
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({ where: { id: eventId }, select: { status: true } });
      if (!event || ['CLOSED', 'ARCHIVED'].includes(event.status)) throw new BadRequestException('Master data cannot be added to a completed event');
      let created: object & { id: string };
      if (type === 'hall') {
        const code = String(body.code ?? '').trim();
        const name = String(body.name ?? '').trim();
        if (!code || !name) throw new BadRequestException('Hall code and name are required');
        created = await tx.hall.create({ data: { eventId, code, name } });
      } else if (type === 'zone') {
        const hallId = String(body.hallId ?? '');
        const code = String(body.code ?? '').trim();
        const hall = await tx.hall.findFirst({ where: { id: hallId, eventId, active: true } });
        if (!hall || !code) throw new BadRequestException('Valid hall and zone code are required');
        created = await tx.zone.create({ data: { eventId, hallId, code } });
      } else {
        const zoneId = String(body.zoneId ?? '');
        const stallCode = String(body.stallCode ?? '').trim();
        const exhibitorName = String(body.exhibitorName ?? '').trim();
        const zone = await tx.zone.findFirst({ where: { id: zoneId, eventId, active: true, hall: { active: true } } });
        if (!zone || !stallCode || !exhibitorName) throw new BadRequestException('Valid zone, stall code, and exhibitor name are required');
        created = await tx.stall.create({ data: { eventId, zoneId, stallCode, exhibitorName, contact: typeof body.contact === 'string' ? body.contact : null } });
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
    });
  }

  async admins(scope: AuthScope) {
    requireAuthority(scope.role, 'SUPER_ADMIN');
    return this.prisma.user.findMany({
      where: { role: 'ADMIN', scopes: { some: { eventId: { in: scope.eventIds } } } },
      select: { id: true, name: true, email: true, status: true, scopes: { select: { event: { select: { id: true, name: true } } } } },
      orderBy: { name: 'asc' },
    });
  }

  async createAdmin(scope: AuthScope, body: { name: string; email: string; password: string; eventIds: string[] }) {
    requireAuthority(scope.role, 'SUPER_ADMIN');
    const eventIds = Array.isArray(body.eventIds) ? [...new Set(body.eventIds)] : [];
    if (!body.name?.trim() || !body.email?.trim() || body.password?.length < 12 || !eventIds.length) {
      throw new BadRequestException('Name, email, 12-character password, and at least one event are required');
    }
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
          role: 'ADMIN',
          scopes: { create: eventIds.map((eventId) => ({ eventId })) },
        },
        select: { id: true, name: true, email: true, status: true },
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
  @Get('metrics') metrics(@CurrentScope() scope: AuthScope) { return this.service.metrics(scope); }
  @Get('timing') timing(@CurrentScope() scope: AuthScope) { return this.service.timing(scope); }
  @Get('portfolio') portfolio(@CurrentScope() scope: AuthScope) { return this.service.portfolio(scope); }
  @Get('exceptions') exceptions(@CurrentScope() scope: AuthScope) { return this.service.exceptions(scope); }
  @Get('audit') audit(@CurrentScope() scope: AuthScope, @Query() query: { action?: string; ticket?: string }) { return this.service.audit(scope, query); }
  @Get('masters') masters(@CurrentScope() scope: AuthScope) { return this.service.masters(scope); }
  @Patch('masters/pools/:id') updatePool(@Param('id') id: string, @CurrentScope() scope: AuthScope, @Body() body: { responseTargetSeconds: number; resolutionTargetSeconds: number; active?: boolean }) { return this.service.updatePool(scope, id, body); }
  @Post('masters/:type') createMaster(@Param('type') type: 'hall' | 'zone' | 'stall', @CurrentScope() scope: AuthScope, @Body() body: Record<string, unknown>) {
    if (!['hall', 'zone', 'stall'].includes(type)) throw new BadRequestException('Unsupported master type');
    return this.service.createMaster(scope, type, body);
  }
  @Get('admins') admins(@CurrentScope() scope: AuthScope) { return this.service.admins(scope); }
  @Post('admins') createAdmin(@CurrentScope() scope: AuthScope, @Body() body: { name: string; email: string; password: string; eventIds: string[] }) { return this.service.createAdmin(scope, body); }
  @Get('exports') exports(@CurrentScope() scope: AuthScope) { return this.service.exports(scope); }
  @Post('exports') export(@CurrentScope() scope: AuthScope, @Body() body: { format: string; filters: unknown; columns: unknown }) { return this.service.createExport(scope, body.format, body.filters, body.columns); }
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

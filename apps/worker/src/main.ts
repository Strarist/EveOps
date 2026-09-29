import { Prisma, PrismaClient } from '@prisma/client';
import { routeTicket } from '@eveops/operations';
import ExcelJS from 'exceljs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();
const interval = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
const maxExportRows = Number(process.env.MAX_EXPORT_ROWS ?? 50000);
if (!Number.isInteger(maxExportRows) || maxExportRows < 1) throw new Error('MAX_EXPORT_ROWS must be a positive integer');
const workerId = 'worker-' + randomUUID();

async function tick() {
  const now = new Date();
  const overdue = await prisma.assignment.findMany({
    where: { status: 'ACTIVE', responseOverdueAt: null, OR: [{ snoozedUntil: { lte: now } }, { assignedAt: { lte: new Date(now.getTime() - 600000) }, snoozedUntil: null }] },
    include: { ticket: true },
  });
  for (const assignment of overdue) await processOverdueAssignment(assignment.id, now);
  await processSlaBreaches();
  await processOutbox();
  await deliverPushes();
  await processExports();
  await expireExports();
  const [outboxBacklog, deadLetteredOutbox, failedExports] = await Promise.all([
    prisma.outboxEvent.count({ where: { processedAt: null, deadLetteredAt: null } }),
    prisma.outboxEvent.count({ where: { deadLetteredAt: { not: null } } }),
    prisma.exportJob.count({ where: { status: 'FAILED' } }),
  ]);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "SystemHeartbeat" (id, "lastSeenAt", metadata)
    VALUES ('primary-worker', NOW(), ${JSON.stringify({ workerId, outboxBacklog, deadLetteredOutbox, failedExports })}::jsonb)
    ON CONFLICT (id) DO UPDATE
    SET "lastSeenAt" = NOW(), metadata = EXCLUDED.metadata
  `);
}

async function expireExports() {
  const expired = await prisma.exportJob.findMany({
    where: { status: 'READY', expiresAt: { lte: new Date() } },
    select: { id: true, storageKey: true },
  });
  const exportDir = process.env.EXPORT_DIR ?? resolve(process.cwd(), '../../exports');
  for (const job of expired) {
    if (job.storageKey) await unlink(resolve(exportDir, job.storageKey)).catch(() => undefined);
    await prisma.exportJob.updateMany({ where: { id: job.id, status: 'READY' }, data: { status: 'EXPIRED', storageKey: null } });
  }
}

async function processSlaBreaches() {
  const candidates = await prisma.$queryRaw<Array<{ id: string; kind: 'RESPONSE' | 'RESOLUTION' }>>(Prisma.sql`
    SELECT t.id, 'RESPONSE'::text AS kind
    FROM "Ticket" t
    JOIN "ServicePool" p ON p.id = t."poolId"
    WHERE t.status NOT IN ('CLOSED', 'CANCELLED')
      AND t."firstAcceptedAt" IS NULL
      AND EXTRACT(EPOCH FROM (NOW() - t."createdAt")) > p."responseTargetSeconds"
      AND NOT EXISTS (
        SELECT 1 FROM "TicketEvent" e
        WHERE e."ticketId" = t.id AND e."eventType" = 'SLA_BREACHED' AND e.metadata ->> 'kind' = 'RESPONSE'
      )
    UNION ALL
    SELECT t.id, 'RESOLUTION'::text AS kind
    FROM "Ticket" t
    JOIN "ServicePool" p ON p.id = t."poolId"
    WHERE t.status NOT IN ('CLOSED', 'CANCELLED')
      AND EXTRACT(EPOCH FROM (NOW() - t."createdAt")) > p."resolutionTargetSeconds"
      AND NOT EXISTS (
        SELECT 1 FROM "TicketEvent" e
        WHERE e."ticketId" = t.id AND e."eventType" = 'SLA_BREACHED' AND e.metadata ->> 'kind' = 'RESOLUTION'
      )
    ORDER BY id, kind
    LIMIT 100
  `);
  for (const candidate of candidates) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${candidate.id}:${candidate.kind}`}, 1))`);
      const prior = await tx.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
        SELECT EXISTS(
          SELECT 1 FROM "TicketEvent"
          WHERE "ticketId" = ${candidate.id}
            AND "eventType" = 'SLA_BREACHED'
            AND metadata ->> 'kind' = ${candidate.kind}
        ) AS exists
      `);
      if (prior[0]?.exists) return;
      const ticket = await tx.ticket.findUnique({ where: { id: candidate.id }, include: { pool: true } });
      if (!ticket || ['CLOSED', 'CANCELLED'].includes(ticket.status)) return;
      const recipients = await tx.userScope.findMany({
        where: {
          eventId: ticket.eventId,
          OR: [
            { hallId: ticket.hallId, user: { role: 'HALL_MANAGER' } },
            { user: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } },
          ],
        },
        select: { userId: true },
      });
      await tx.ticketEvent.create({
        data: { eventId: ticket.eventId, ticketId: ticket.id, eventType: 'SLA_BREACHED', fromStatus: ticket.status, toStatus: ticket.status, correlationId: `worker-sla-${candidate.kind.toLowerCase()}-${ticket.id}`, metadata: { kind: candidate.kind } },
      });
      await tx.notification.createMany({
        data: recipients.map(({ userId }) => ({
          eventId: ticket.eventId,
          recipientId: userId,
          ticketId: ticket.id,
          type: 'SLA_BREACHED',
          dedupeKey: `sla-breached:${candidate.kind.toLowerCase()}:${ticket.id}:${userId}`,
          payload: { kind: candidate.kind, responseTargetSeconds: ticket.pool?.responseTargetSeconds, resolutionTargetSeconds: ticket.pool?.resolutionTargetSeconds },
        })),
        skipDuplicates: true,
      });
      await tx.outboxEvent.create({
        data: { eventId: ticket.eventId, aggregateType: 'Ticket', aggregateId: ticket.id, eventType: 'SLA_BREACHED', payload: { ticketId: ticket.id, eventId: ticket.eventId, hallId: ticket.hallId, stallId: ticket.stallId, kind: candidate.kind } },
      });
    });
  }
}

async function processOverdueAssignment(assignmentId: string, now: Date) {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.assignment.updateMany({
      where: {
        id: assignmentId,
        status: 'ACTIVE',
        responseOverdueAt: null,
        OR: [{ snoozedUntil: { lte: now } }, { assignedAt: { lte: new Date(now.getTime() - 600000) }, snoozedUntil: null }],
      },
      data: { responseOverdueAt: now },
    });
    if (claimed.count !== 1) return;
    const assignment = await tx.assignment.findUniqueOrThrow({ where: { id: assignmentId }, include: { ticket: true } });
    const recipients = await tx.userScope.findMany({
      where: {
        eventId: assignment.ticket.eventId,
        OR: [
          { hallId: assignment.ticket.hallId, user: { role: 'HALL_MANAGER' } },
          { user: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } },
        ],
      },
      select: { userId: true },
    });
    await tx.ticketEvent.create({
      data: {
        eventId: assignment.ticket.eventId,
        ticketId: assignment.ticketId,
        eventType: 'ASSIGNMENT_RESPONSE_OVERDUE',
        fromStatus: assignment.ticket.status,
        toStatus: assignment.ticket.status,
        correlationId: `worker-${assignment.id}`,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventId: assignment.ticket.eventId,
        aggregateType: 'Ticket',
        aggregateId: assignment.ticketId,
        eventType: 'ASSIGNMENT_RESPONSE_OVERDUE',
        payload: {
          ticketId: assignment.ticketId,
          eventId: assignment.ticket.eventId,
          hallId: assignment.ticket.hallId,
          stallId: assignment.ticket.stallId,
          assigneeId: assignment.staffId,
        },
      },
    });
    const recipientIds = [...new Set([assignment.staffId, ...recipients.map(({ userId }) => userId)])];
    await tx.notification.createMany({
      data: recipientIds.map((userId) => ({
        eventId: assignment.ticket.eventId,
        recipientId: userId,
        ticketId: assignment.ticketId,
        type: 'ASSIGNMENT_RESPONSE_OVERDUE',
        dedupeKey: `assignment-overdue:${assignment.id}:${userId}`,
        payload: { assignmentId: assignment.id },
      })),
      skipDuplicates: true,
    });
  });
}

async function deliverPushes() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const webpush = await import('web-push');
  webpush.default.setVapidDetails(process.env.VAPID_SUBJECT ?? 'mailto:ops@eveops.local', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const pending = await prisma.notification.findMany({
    where: { pushedAt: null, pushAttempts: { lt: 5 }, sentAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    take: 25,
    include: { recipient: { include: { pushSubscriptions: true } } },
  });
  for (const notification of pending) {
    const payload = notification.payload && typeof notification.payload === 'object' && !Array.isArray(notification.payload)
      ? notification.payload as Record<string, unknown>
      : {};
    const summary = typeof payload.summary === 'string' ? payload.summary : 'You have an update';
    const target = notification.recipient.role === 'STAFF' && notification.ticketId
      ? '/staff/task/' + notification.ticketId
      : notification.recipient.role === 'STALL' && notification.ticketId
        ? '/stall/ticket/' + notification.ticketId
        : notification.recipient.role === 'HALL_MANAGER'
          ? '/hall-manager'
          : '/';
    const url = target.startsWith('/') && !target.startsWith('//') ? target : '/';
    let failed = false;
    for (const subscription of notification.recipient.pushSubscriptions) {
      try {
        await webpush.default.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, JSON.stringify({ title: 'EveOps', body: summary, url, tag: notification.id }));
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => undefined);
        } else {
          failed = true;
        }
      }
    }
    await prisma.notification.update({
      where: { id: notification.id },
      data: failed ? { pushAttempts: { increment: 1 } } : { pushedAt: new Date(), pushAttempts: { increment: 1 } },
    });
  }
}

async function processOutbox() {
  const staleBefore = new Date(Date.now() - 60000);
  const events = await prisma.$queryRaw<Array<{ id: string; eventId: string | null; aggregateId: string; aggregateType: string; eventType: string; payload: Prisma.JsonValue; attempts: number }>>(Prisma.sql`
    WITH candidates AS (
      SELECT id
      FROM "OutboxEvent"
      WHERE "processedAt" IS NULL
        AND "deadLetteredAt" IS NULL
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
        AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
      ORDER BY "createdAt", id
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    )
    UPDATE "OutboxEvent" o
    SET "lockedAt" = NOW(), "lockOwner" = ${workerId}, attempts = attempts + 1
    FROM candidates
    WHERE o.id = candidates.id
    RETURNING o.id, o."eventId", o."aggregateId", o."aggregateType", o."eventType", o.payload, o.attempts
  `);
  for (const event of events) {
    try {
      if (event.aggregateType === 'Ticket' && ['TICKET_CREATED', 'STATUS_REOPENED'].includes(event.eventType)) {
        const ticket = await prisma.ticket.findUnique({ where: { id: event.aggregateId }, select: { status: true } });
        if (ticket && ['NEW', 'REOPENED'].includes(ticket.status)) {
          await routeTicket(prisma, event.aggregateId, undefined, `outbox-${event.id}`);
        }
      }
      const ticket = event.aggregateType === 'Ticket'
        ? await prisma.ticket.findUnique({
            where: { id: event.aggregateId },
            include: { assignments: { take: 1, orderBy: { assignedAt: 'desc' } } },
          })
        : null;
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, Prisma.JsonValue>
        : {};
      const signal = ticket
        ? {
            ...(ticket.assignments[0] && ['ACTIVE', 'ACCEPTED'].includes(ticket.assignments[0].status)
              ? { assigneeId: ticket.assignments[0].staffId }
              : {}),
            id: event.id,
            eventId: ticket.eventId,
            hallId: ticket.hallId,
            stallId: ticket.stallId,
            assigneeIds: [...new Set([
              ticket.assignments[0]?.staffId,
              typeof payload.assigneeId === 'string' ? payload.assigneeId : undefined,
              typeof payload.previousAssigneeId === 'string' ? payload.previousAssigneeId : undefined,
            ].filter((value): value is string => !!value))],
            type: 'ticket.updated',
            data: { ticketId: ticket.id, version: ticket.version },
          }
        : {
            id: event.id,
            eventId: event.eventId ?? payload.eventId,
            hallId: payload.hallId,
            stallId: payload.stallId,
            assigneeId: payload.assigneeId,
            type: event.eventType,
            data: event.payload,
          };
      if (signal.eventId) {
        await prisma.$executeRaw(Prisma.sql`SELECT pg_notify('expoops_events', ${JSON.stringify(signal)})`);
      }
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date(), lockedAt: null, lockOwner: null, lastError: null, nextAttemptAt: null },
      });
    } catch (error) {
      const deadLettered = event.attempts >= 8;
      const retryDelayMs = Math.min(15 * 60 * 1000, 5000 * (2 ** Math.max(0, event.attempts - 1)));
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          lockedAt: null,
          lockOwner: null,
          lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown outbox error',
          nextAttemptAt: deadLettered ? null : new Date(Date.now() + retryDelayMs),
          deadLetteredAt: deadLettered ? new Date() : null,
        },
      });
    }
  }
}

async function processExports() {
  await prisma.exportJob.updateMany({
    where: { status: 'PROCESSING', processingStartedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } },
    data: { status: 'PENDING', processingStartedAt: null, lastError: 'Recovered stale export claim' },
  });
  const jobs = await prisma.exportJob.findMany({
    where: { status: 'PENDING' },
    include: { requestedBy: { include: { scopes: true } } },
    take: 5,
  });
  const exportDir = process.env.EXPORT_DIR ?? resolve(process.cwd(), '../../exports');
  await mkdir(exportDir, { recursive: true });

  for (const job of jobs) {
    const claim = await prisma.exportJob.updateMany({
      where: { id: job.id, status: 'PENDING' },
      data: { status: 'PROCESSING', processingStartedAt: new Date(), attempts: { increment: 1 }, lastError: null },
    });
    if (claim.count !== 1) continue;
    try {
      const authorizedEventIds = [...new Set(job.requestedBy.scopes.map((scope) => scope.eventId))];
      if (!['ADMIN', 'SUPER_ADMIN'].includes(job.requestedBy.role) || job.requestedBy.status !== 'ACTIVE' || !job.eventIds.length || job.eventIds.some((eventId) => !authorizedEventIds.includes(eventId))) {
        throw new Error('Export authorization changed before generation');
      }
      const filters = job.filterSnapshot as Record<string, unknown>;
      const where: Prisma.TicketWhereInput = { eventId: { in: job.eventIds } };
      if (typeof filters.hallId === 'string') where.hallId = filters.hallId;
      if (typeof filters.zoneId === 'string') where.zoneId = filters.zoneId;
      if (typeof filters.stallId === 'string') where.stallId = filters.stallId;
      if (typeof filters.status === 'string') where.status = filters.status as Prisma.EnumTicketStatusFilter;
      if (typeof filters.category === 'string') where.category = filters.category;
      if (typeof filters.subtype === 'string') where.subtype = filters.subtype;
      if (typeof filters.priority === 'string') where.priority = filters.priority as Prisma.EnumTicketPriorityFilter;
      if (typeof filters.assigneeId === 'string') where.assignments = { some: { staffId: filters.assigneeId } };
      if (filters.reopened === true) where.reopenCount = { gt: 0 };
      if (filters.complaint === true) where.complaints = { some: {} };
      if (typeof filters.search === 'string' && filters.search.trim()) {
        where.OR = [
          { publicNo: { contains: filters.search.trim(), mode: 'insensitive' } },
          { stall: { stallCode: { contains: filters.search.trim(), mode: 'insensitive' } } },
        ];
      }
      if (typeof filters.dateFrom === 'string' || typeof filters.dateTo === 'string') {
        where.createdAt = {
          ...(typeof filters.dateFrom === 'string' ? { gte: new Date(filters.dateFrom) } : {}),
          ...(typeof filters.dateTo === 'string' ? { lte: new Date(filters.dateTo) } : {}),
        };
      }
      const tickets = await prisma.ticket.findMany({
        where,
        include: {
          event: true,
          pool: true,
          hall: true,
          zone: true,
          stall: true,
          assignments: { orderBy: { assignedAt: 'asc' } },
          complaints: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: maxExportRows + 1,
      });
      if (tickets.length > maxExportRows) {
        throw new Error(`Export exceeds the ${maxExportRows} row safety limit; narrow the filters`);
      }
      const filteredTickets = tickets.filter((ticket) => {
        const responseSeconds = ticket.firstAcceptedAt ? Math.floor((ticket.firstAcceptedAt.getTime() - ticket.createdAt.getTime()) / 1000) : null;
        const workSeconds = ticket.assignments.reduce((sum, assignment) => sum + (assignment.startedAt && assignment.completionRequestedAt ? Math.floor((assignment.completionRequestedAt.getTime() - assignment.startedAt.getTime()) / 1000) : 0), 0);
        const resolutionSeconds = ticket.closedAt ? Math.floor((ticket.closedAt.getTime() - ticket.createdAt.getTime()) / 1000) : null;
        if (typeof filters.responseMinSeconds === 'number' && (responseSeconds == null || responseSeconds < filters.responseMinSeconds)) return false;
        if (typeof filters.workMinSeconds === 'number' && workSeconds < filters.workMinSeconds) return false;
        if (typeof filters.resolutionMinSeconds === 'number' && (resolutionSeconds == null || resolutionSeconds < filters.resolutionMinSeconds)) return false;
        if (filters.slaState === 'BREACHED') {
          const responseBreached = responseSeconds != null
            ? responseSeconds > (ticket.pool?.responseTargetSeconds ?? 600)
            : Date.now() - ticket.createdAt.getTime() > (ticket.pool?.responseTargetSeconds ?? 600) * 1000;
          const resolutionBreached = resolutionSeconds != null
            ? resolutionSeconds > (ticket.pool?.resolutionTargetSeconds ?? 3600)
            : Date.now() - ticket.createdAt.getTime() > (ticket.pool?.resolutionTargetSeconds ?? 3600) * 1000;
          if (!responseBreached && !resolutionBreached) return false;
        }
        return true;
      });
      const completeRows = filteredTickets.map((ticket) => ({
        ticket_number: ticket.publicNo,
        event_id: ticket.eventId,
        event_timezone: ticket.event.timezone,
        hall: ticket.hall.code,
        zone: ticket.zone.code,
        stall: ticket.stall.stallCode,
        category: ticket.category,
        subtype: ticket.subtype,
        priority: ticket.priority,
        status: ticket.status,
        created_at: ticket.createdAt.toISOString(),
        assigned_at: ticket.firstAssignedAt?.toISOString() ?? '',
        accepted_at: ticket.firstAcceptedAt?.toISOString() ?? '',
        started_at: ticket.firstStartedAt?.toISOString() ?? '',
        completion_requested_at: ticket.completionRequestedAt?.toISOString() ?? '',
        closed_at: ticket.closedAt?.toISOString() ?? '',
        raise_to_assign_seconds: ticket.firstAssignedAt ? Math.floor((ticket.firstAssignedAt.getTime() - ticket.createdAt.getTime()) / 1000) : '',
        assign_to_accept_seconds: ticket.firstAssignedAt && ticket.firstAcceptedAt ? Math.floor((ticket.firstAcceptedAt.getTime() - ticket.firstAssignedAt.getTime()) / 1000) : '',
        accept_to_start_seconds: ticket.firstAcceptedAt && ticket.firstStartedAt ? Math.floor((ticket.firstStartedAt.getTime() - ticket.firstAcceptedAt.getTime()) / 1000) : '',
        active_work_seconds: ticket.assignments.reduce((sum, assignment) => sum + (assignment.startedAt && assignment.completionRequestedAt ? Math.floor((assignment.completionRequestedAt.getTime() - assignment.startedAt.getTime()) / 1000) : 0), 0),
        otp_wait_seconds: ticket.completionRequestedAt && ticket.closedAt ? Math.floor((ticket.closedAt.getTime() - ticket.completionRequestedAt.getTime()) / 1000) : '',
        resolution_seconds: ticket.closedAt ? Math.floor((ticket.closedAt.getTime() - ticket.createdAt.getTime()) / 1000) : '',
        reopen_count: ticket.reopenCount,
        complaint_count: ticket.complaints.length,
        assignment_cycle_count: ticket.assignments.length,
        assignment_cycles_json: JSON.stringify(ticket.assignments.map((assignment, index) => ({
          attempt: index + 1,
          assigned_at: assignment.assignedAt.toISOString(),
          accepted_at: assignment.acceptedAt?.toISOString() ?? null,
          started_at: assignment.startedAt?.toISOString() ?? null,
          completion_requested_at: assignment.completionRequestedAt?.toISOString() ?? null,
          released_at: assignment.releasedAt?.toISOString() ?? null,
          release_reason: assignment.releaseReason,
        }))),
        response_sla_target_seconds: ticket.pool?.responseTargetSeconds ?? '',
        resolution_sla_target_seconds: ticket.pool?.resolutionTargetSeconds ?? '',
      }));
      const requestedColumns = Array.isArray(job.visibleColumns)
        ? job.visibleColumns.filter((value): value is string => typeof value === 'string')
        : [];
      const allowedColumns = Object.keys(completeRows[0] ?? { ticket_number: '' });
      const columns = requestedColumns.length
        ? requestedColumns.filter((column) => allowedColumns.includes(column))
        : allowedColumns;
      const rows = completeRows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column as keyof typeof row]])));
      const format = job.format.toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
      const fileName = job.id + '.' + format;
      const filePath = resolve(exportDir, fileName);

      if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Tickets');
        sheet.columns = columns.map((key) => ({
          header: key,
          key,
          width: Math.max(14, key.length + 2),
        }));
        sheet.addRows(rows);
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        await workbook.xlsx.writeFile(filePath);
      } else {
        const escape = (value: unknown) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
        const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => escape(row[key])).join(','))].join('\n');
        await writeFile(filePath, csv, 'utf8');
      }
      await prisma.exportJob.update({
        where: { id: job.id },
        data: {
          status: 'READY',
          rowCount: rows.length,
          storageKey: fileName,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          processingStartedAt: null,
        },
      });
      await prisma.outboxEvent.createMany({
        data: job.eventIds.map((eventId) => ({
          eventId,
          aggregateType: 'ExportJob',
          aggregateId: job.id,
          eventType: 'EXPORT_GENERATED',
          payload: { requestedById: job.requestedById, rowCount: rows.length, filterSnapshot: filters as Prisma.InputJsonObject },
        })),
      });
    } catch (error) {
      console.error('Export failed', job.id, error);
      await prisma.exportJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', processingStartedAt: null, lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown export error' },
      });
    }
  }
}

async function run() {
  await prisma.$connect();
  while (true) {
    const startedAt = Date.now();
    await tick().catch(console.error);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, interval - (Date.now() - startedAt))));
  }
}

void run().catch((error) => { console.error(error); process.exit(1); });

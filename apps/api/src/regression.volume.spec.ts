import { createHash, randomBytes } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import type { Response } from 'express';
import { deliverNotificationPush, deliverPendingPushes, describeTicketTiming, serviceQueueOrderBy, type PushSend } from '@eveops/operations';
import { AppModule } from './app.module';
import { AuthController } from './auth';
import { SanitizedExceptionFilter } from './http-exception.filter';
import { ManagementService } from './management';
import { PrismaService } from './prisma.service';
import {
  assertRegressionDatabase,
  ensureRegressionFixture,
  regressionFixturePassword,
  type RegressionFixture,
  type RegressionStall,
  type RegressionStaff,
} from './regression-fixture';
import { ListTicketsDto, TicketService } from './tickets';
import { WorkforceService } from './workforce';

jest.setTimeout(120000);

const isolated = (() => {
  try {
    assertRegressionDatabase();
    return true;
  } catch {
    return false;
  }
})();

(isolated ? describe : describe.skip)('40-user regression lab', () => {
  const prisma = new PrismaService();
  const tickets = new TicketService(prisma);
  const workforce = new WorkforceService(prisma, tickets);
  const management = new ManagementService(prisma);
  let lab: RegressionFixture;
  let app: INestApplication;
  let baseUrl = '';

  beforeAll(async () => {
    process.env.ALLOW_DEMO_SEED = 'false';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
      ? process.env.SESSION_SECRET
      : 'regression-lab-session-secret-32chars';
    process.env.OTP_ENCRYPTION_SECRET = process.env.OTP_ENCRYPTION_SECRET && process.env.OTP_ENCRYPTION_SECRET.length >= 32
      ? process.env.OTP_ENCRYPTION_SECRET
      : 'regression-lab-otp-secret-32-characters';
    await prisma.$connect();
    lab = await ensureRegressionFixture(prisma);
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new SanitizedExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterEach(async () => {
    await removeCaseTickets(prisma);
    await removeCasePeople(prisma);
    await restoreStaff(prisma, lab);
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it('signs every lab account into its own portal', async () => {
    const auth = new AuthController(prisma);
    const response = { cookie() { return undefined; } } as unknown as Response;
    const accounts = [
      lab.admin,
      lab.superAdmin,
      ...lab.managers,
      ...lab.stalls.map((stall) => ({ email: stall.email, role: 'STALL' as const })),
      ...lab.staff.map((person) => ({ email: person.email, role: 'STAFF' as const })),
    ];
    expect(accounts).toHaveLength(40);
    for (const account of accounts) {
      const portal = account.role === 'SUPER_ADMIN' ? 'GOVERNANCE' : 'OPERATIONS';
      const result = await auth.login({ email: account.email, password: regressionFixturePassword(), portal }, response);
      expect(result.user.role).toBe(account.role);
    }
    await expect(auth.login({
      email: lab.stalls[0].email,
      password: regressionFixturePassword(),
      portal: 'GOVERNANCE',
    }, response)).rejects.toThrow('not authorized');
    await expect(auth.login({
      email: lab.superAdmin.email,
      password: regressionFixturePassword(),
      portal: 'OPERATIONS',
    }, response)).rejects.toThrow('not authorized');
  });

  it('enforces scope on direct API requests', async () => {
    const stall = lab.stalls[0];
    const otherStall = lab.stalls.find((row) => row.hallCode === 'H2')!;
    const manager = lab.managers[0];
    const otherManager = lab.managers[1];
    const electrician = lab.staff.find((person) => person.hallCode === 'H1' && person.kind === 'ELECTRICAL' && person.slot === 1)!;
    const stallCookie = await login(baseUrl, stall.email, 'OPERATIONS');
    const staffCookie = await login(baseUrl, electrician.email, 'OPERATIONS');
    const managerCookie = await login(baseUrl, manager.email, 'OPERATIONS');
    const adminCookie = await login(baseUrl, lab.admin.email, 'OPERATIONS');
    const superCookie = await login(baseUrl, lab.superAdmin.email, 'GOVERNANCE');

    const ownList = await api(baseUrl, '/api/tickets', stallCookie);
    expect(ownList.status).toBe(200);
    const ownBody = await ownList.json() as { items: Array<{ stallId: string }> };
    expect(ownBody.items.every((item) => item.stallId === stall.id)).toBe(true);

    const otherTicket = await api(baseUrl, `/api/tickets/${lab.busyTicketIds[1]}`, stallCookie);
    expect(otherTicket.status).toBeGreaterThanOrEqual(400);

    const priorityAttempt = await api(baseUrl, '/api/tickets', stallCookie, {
      method: 'POST',
      body: JSON.stringify({
        category: 'HOUSE_HELP',
        subtype: 'General',
        description: 'Trying to set its own service priority',
        idempotencyKey: `case-priority-${Date.now()}`,
        servicePriority: 'HIGH',
      }),
    });
    expect(priorityAttempt.status).toBe(400);

    const staffList = await api(baseUrl, '/api/tickets?view=active', staffCookie);
    expect(staffList.status).toBe(200);
    const staffBody = await staffList.json() as { items: Array<{ id: string }> };
    for (const busyId of lab.busyTicketIds) {
      expect(staffBody.items.map((item) => item.id)).not.toContain(busyId);
    }
    const foreignTask = await api(baseUrl, `/api/tickets/${lab.busyTicketIds[1]}`, staffCookie);
    expect(foreignTask.status).toBeGreaterThanOrEqual(400);

    const managerList = await api(baseUrl, '/api/tickets', managerCookie);
    const managerBody = await managerList.json() as { items: Array<{ hallId: string }> };
    expect(managerBody.items.every((item) => item.hallId === manager.hallId)).toBe(true);
    const managerRegistrations = await api(baseUrl, '/api/management/registrations', managerCookie);
    expect(managerRegistrations.status).toBe(403);

    const adminBoundary = await api(baseUrl, `/api/tickets?eventId=${lab.boundaryEventId}`, adminCookie);
    expect(adminBoundary.status).toBe(403);
    const adminForeign = await api(baseUrl, `/api/tickets?eventId=${lab.foreignEventId}`, adminCookie);
    expect(adminForeign.status).toBe(403);
    const adminUsers = await api(baseUrl, '/api/management/admins', adminCookie);
    expect(adminUsers.status).toBe(403);

    const superBoundary = await api(baseUrl, `/api/tickets?eventId=${lab.boundaryEventId}`, superCookie);
    expect(superBoundary.status).toBe(200);
    const superOutside = await api(baseUrl, `/api/tickets?eventId=${lab.outsideEventId}`, superCookie);
    expect(superOutside.status).toBe(403);
    const superForeign = await api(baseUrl, `/api/tickets?eventId=${lab.foreignEventId}`, superCookie);
    expect(superForeign.status).toBe(403);
    const superRegistrations = await api(baseUrl, '/api/management/registrations', superCookie);
    expect(superRegistrations.status).toBe(200);
    const registrationBody = await superRegistrations.json() as Array<{ id: string; eventId?: string }>;
    expect(registrationBody.some((row) => row.id === 'regression-stall-boundary')).toBe(true);
    expect(registrationBody.some((row) => row.id === 'regression-stall-outside')).toBe(false);

    const otherHall = await tickets.list(otherManager.scope, { view: 'all', limit: 50 });
    expect(otherHall.items.every((item) => item.hallId === otherManager.hallId)).toBe(true);
    await expect(tickets.detail(lab.busyTicketIds[0], otherStallScope(otherStall))).rejects.toThrow(/scope/i);
  });

  it('selects queued work by override, service priority, creation time, then id', async () => {
    const hall = hall4(lab);
    const worker = staffBy(lab, 'H4', 'ELECTRICAL', 1);
    await workforce.availability(staffScope(worker), 'OFF_DUTY');
    const stall = stallsIn(lab, 'H4')[0];
    const olderLow = await createCase(tickets, stall, 'ELECTRICAL', 'Lighting', 'Older urgent low priority work', 'URGENT', 'case-queue-low');
    const newerHigh = await createCase(tickets, stallsIn(lab, 'H4')[1], 'ELECTRICAL', 'Lighting', 'Newer normal high priority work', 'NORMAL', 'case-queue-high');
    const equalA = await createCase(tickets, stallsIn(lab, 'H4')[2], 'ELECTRICAL', 'Lighting', 'Equal priority first created', 'NORMAL', 'case-queue-eq-a');
    const equalB = await createCase(tickets, stallsIn(lab, 'H4')[3], 'ELECTRICAL', 'Lighting', 'Equal priority second created', 'NORMAL', 'case-queue-eq-b');
    await prisma.ticket.update({ where: { id: equalB.id }, data: { createdAt: equalA.createdAt } });
    const lowOverride = olderLow.id;
    const highOverride = newerHigh.id;
    await tickets.prioritizeQueued(lowOverride, hall.manager.scope, 'Stage is live');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tickets.prioritizeQueued(highOverride, hall.manager.scope, 'Later manager override');
    await prisma.ticket.update({ where: { id: equalA.id }, data: { servicePriority: 'MEDIUM' } });
    await prisma.ticket.update({ where: { id: equalB.id }, data: { servicePriority: 'MEDIUM' } });

    const waiting = await prisma.ticket.findMany({
      where: { id: { in: [olderLow.id, newerHigh.id, equalA.id, equalB.id] }, status: 'QUEUED' },
      orderBy: serviceQueueOrderBy,
    });
    expect(waiting.map((ticket) => ticket.id)).toEqual([olderLow.id, newerHigh.id, ...[equalA.id, equalB.id].sort()]);
    expect(olderLow.priority).toBe('URGENT');
    expect(newerHigh.priority).toBe('NORMAL');

    await workforce.availability(staffScope(worker), 'ON_DUTY');
    const assigned = await prisma.assignment.findFirstOrThrow({
      where: { staffId: worker.id, status: { in: ['ACTIVE', 'ACCEPTED'] }, ticketId: { in: waiting.map((ticket) => ticket.id) } },
    });
    expect(assigned.ticketId).toBe(olderLow.id);
    const untouched = await prisma.ticket.findUniqueOrThrow({ where: { id: newerHigh.id } });
    expect(untouched.status).toBe('QUEUED');
  });

  it('uses the same order when a worker comes on duty, when capacity is released, and when work is reassigned', async () => {
    const hall = hall4(lab);
    const primary = staffBy(lab, 'H4', 'ELECTRICAL', 1);
    const secondary = staffBy(lab, 'H4', 'ELECTRICAL', 2);
    await workforce.availability(staffScope(primary), 'OFF_DUTY');
    const stalls = stallsIn(lab, 'H4');
    const low = await createCase(tickets, stalls[0], 'ELECTRICAL', 'Lighting', 'Low work waiting behind high', 'NORMAL', 'case-drain-low');
    const high = await createCase(tickets, stalls[1], 'ELECTRICAL', 'Lighting', 'High work selected on duty', 'NORMAL', 'case-drain-high');
    await prisma.ticket.update({ where: { id: low.id }, data: { servicePriority: 'LOW', createdAt: new Date('2026-10-01T01:00:00Z') } });
    await prisma.ticket.update({ where: { id: high.id }, data: { servicePriority: 'HIGH', createdAt: new Date('2026-10-01T02:00:00Z') } });
    await workforce.availability(staffScope(primary), 'ON_DUTY');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: high.id } })).status).toBe('ASSIGNED');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: low.id } })).status).toBe('QUEUED');

    await prisma.workforceMembership.updateMany({ where: { userId: secondary.id }, data: { availability: 'ON_DUTY' } });
    await workforce.reassign(high.id, secondary.id, 'Cover the live booth', hall.manager.scope);
    const released = await prisma.ticket.findUniqueOrThrow({ where: { id: low.id } });
    expect(released.status).toBe('ASSIGNED');
    const lowAssignment = await prisma.assignment.findFirstOrThrow({
      where: { ticketId: low.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    });
    expect(lowAssignment.staffId).toBe(primary.id);

    await removeCaseTickets(prisma);
    await workforce.availability(staffScope(primary), 'OFF_DUTY');
    await prisma.workforceMembership.updateMany({ where: { userId: secondary.id }, data: { availability: 'OFF_DUTY' } });
    const first = await createCase(tickets, stalls[2], 'ELECTRICAL', 'Lighting', 'First equal ticket for release drain', 'NORMAL', 'case-release-first');
    const second = await createCase(tickets, stalls[3], 'ELECTRICAL', 'Lighting', 'Second equal ticket for release drain', 'NORMAL', 'case-release-second');
    await workforce.availability(staffScope(primary), 'ON_DUTY');
    const firstRow = await prisma.ticket.findUniqueOrThrow({ where: { id: first.id } });
    const secondRow = await prisma.ticket.findUniqueOrThrow({ where: { id: second.id } });
    const holder = firstRow.status === 'ASSIGNED' ? firstRow : secondRow;
    const waitingId = holder.id === first.id ? second.id : first.id;
    expect(holder.status).toBe('ASSIGNED');
    const assignee = staffScope(primary);
    await tickets.transition(holder.id, 'ACCEPTED', assignee);
    await tickets.transition(holder.id, 'IN_PROGRESS', assignee);
    await tickets.transition(holder.id, 'AWAITING_OTP', assignee);
    const holderStall = stalls.find((stall) => stall.id === holder.stallId)!;
    const presented = await tickets.presentOtp(holder.id, stallScope(holderStall));
    expect(presented.otp).toMatch(/^\d{6}$/);
    await tickets.verifyOtp(holder.id, presented.otp!, assignee);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: waitingId } })).status).toBe('ASSIGNED');
  });

  it('keeps one assignee and one capacity slot under concurrent creates', async () => {
    const stalls = stallsIn(lab, 'H1').slice(0, 5);
    const created = await Promise.all(stalls.map((stall, index) => createCase(
      tickets,
      stall,
      'ELECTRICAL',
      'Lighting',
      `Concurrent lighting request ${index}`,
      'NORMAL',
      `case-concurrent-${index}-${Date.now()}`,
    )));
    const assigned = created.filter((ticket) => ticket.status === 'ASSIGNED');
    const queued = created.filter((ticket) => ticket.status === 'QUEUED');
    expect(assigned).toHaveLength(1);
    expect(queued).toHaveLength(4);
    const active = await prisma.assignment.groupBy({
      by: ['ticketId'],
      where: { ticketId: { in: created.map((ticket) => ticket.id) }, status: { in: ['ACTIVE', 'ACCEPTED'] } },
      _count: { _all: true },
    });
    expect(active).toHaveLength(1);
    expect(active[0]._count._all).toBe(1);
    const busyStaff = staffBy(lab, 'H1', 'ELECTRICAL', 2);
    const extra = await prisma.assignment.count({
      where: { staffId: busyStaff.id, ticketId: { in: created.map((ticket) => ticket.id) }, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    });
    expect(extra).toBe(0);
  });

  it('snapshots stall priority and allows only managers to change a waiting ticket', async () => {
    const stall = stallsIn(lab, 'H3')[0];
    const manager = lab.managers.find((person) => person.hallId === stall.hallId)!;
    const worker = staffBy(lab, 'H3', 'HOUSE_HELP', 1);
    await workforce.availability(staffScope(worker), 'OFF_DUTY');
    const before = await prisma.stall.findUniqueOrThrow({ where: { id: stall.id } });
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Snapshot priority before a stall edit', 'NORMAL', 'case-snapshot');
    const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.servicePriority).toBe(before.servicePriority);
    await management.updateRegistration(lab.admin.scope, stall.id, { servicePriority: before.servicePriority === 'LOW' ? 'HIGH' : 'LOW' });
    const historical = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(historical.servicePriority).toBe(before.servicePriority);
    const next = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Ticket created after the stall edit', 'URGENT', 'case-snapshot-next');
    const nextRow = await prisma.ticket.findUniqueOrThrow({ where: { id: next.id } });
    expect(nextRow.servicePriority).not.toBe(before.servicePriority);
    expect(next.priority).toBe('URGENT');
    await tickets.changePendingServicePriority(created.id, manager.scope, stored.servicePriority === 'HIGH' ? 'MEDIUM' : 'HIGH', 'Live demonstration');
    await expect(tickets.changePendingServicePriority(created.id, staffScope(worker), 'HIGH', 'Staff cannot reorder')).rejects.toThrow(/authority/i);
    await expect(tickets.changePendingServicePriority(created.id, stallScope(stall), 'HIGH', 'Exhibitor cannot reorder')).rejects.toThrow(/authority/i);
    await workforce.availability(staffScope(worker), 'ON_DUTY');
    const assigned = await prisma.ticket.findFirstOrThrow({
      where: { id: { in: [created.id, next.id] }, status: 'ASSIGNED' },
    });
    await expect(tickets.changePendingServicePriority(assigned.id, manager.scope, 'LOW', 'Assigned work stays put')).rejects.toThrow(/waiting to be assigned/);
    await prisma.stall.update({ where: { id: stall.id }, data: { servicePriority: before.servicePriority } });
  });

  it('runs the supported housekeeping lifecycle, including OTP failure and reopen', async () => {
    const stall = stallsIn(lab, 'H3')[2];
    const manager = lab.managers.find((person) => person.hallId === stall.hallId)!;
    const worker = staffBy(lab, 'H3', 'HOUSE_HELP', 1);
    const otherHallManager = lab.managers.find((person) => person.hallCode === 'H1')!;
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Cleanup the booth aisle', 'NORMAL', 'case-lifecycle');
    expect(created.status).toBe('ASSIGNED');
    const assignee = staffScope(worker);
    const snoozed = await tickets.snooze(created.id, assignee);
    expect(snoozed.status).toBe('SNOOZED');
    await expect(tickets.snooze(created.id, assignee)).rejects.toThrow(/Snooze/);
    await tickets.transition(created.id, 'ACCEPTED', assignee);
    await tickets.transition(created.id, 'IN_PROGRESS', assignee);
    await tickets.transition(created.id, 'AWAITING_OTP', assignee);
    await expect(tickets.verifyOtp(created.id, '000000', assignee)).rejects.toThrow('Invalid OTP');
    await prisma.otpChallenge.updateMany({
      where: { ticketId: created.id, invalidatedAt: null, verifiedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 60000) },
    });
    await expect(tickets.verifyOtp(created.id, '000000', assignee)).rejects.toThrow('OTP expired');
    await tickets.regenerateOtp(created.id, stallScope(stall));
    const presented = await tickets.presentOtp(created.id, stallScope(stall));
    expect(presented.otp).toMatch(/^\d{6}$/);
    await expect(tickets.presentOtp(created.id, assignee)).rejects.toThrow(/stall/i);
    const closed = await tickets.verifyOtp(created.id, presented.otp!, manager.scope);
    expect(closed.status).toBe('CLOSED');
    const reopened = await tickets.transition(created.id, 'REOPENED', manager.scope, 'Work was incomplete');
    const persisted = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(['ASSIGNED', 'QUEUED']).toContain(persisted.status);
    expect(reopened.status).toBe(persisted.status);
    expect(reopened.reopenCount).toBe(persisted.reopenCount);
    const alerts = await prisma.notification.findMany({ where: { ticketId: created.id, type: 'TICKET_REOPENED' } });
    expect(alerts.some((alert) => alert.recipientId === stall.userId)).toBe(true);
    expect(alerts.some((alert) => alert.recipientId === manager.id)).toBe(false);
    expect(alerts.some((alert) => alert.recipientId === otherHallManager.id)).toBe(false);
    const activity = await tickets.activity(created.id, manager.scope);
    expect(activity.items.map((item) => item.eventType)).toEqual(expect.arrayContaining(['TICKET_CREATED', 'OTP_VERIFIED', 'STATUS_REOPENED']));
    const stallActivity = await tickets.activity(created.id, stallScope(stall));
    expect(stallActivity.items.every((item) => !('eventType' in item) && typeof item.summary === 'string')).toBe(true);
  });

  it('records a stall complaint without closing the ticket', async () => {
    const stall = stallsIn(lab, 'H3')[3];
    const manager = lab.managers.find((person) => person.hallId === stall.hallId)!;
    const worker = staffBy(lab, 'H3', 'HOUSE_HELP', 1);
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Complaint while waiting for the code', 'NORMAL', 'case-complaint');
    const assignee = staffScope(worker);
    await tickets.transition(created.id, 'ACCEPTED', assignee);
    await tickets.transition(created.id, 'IN_PROGRESS', assignee);
    await tickets.transition(created.id, 'AWAITING_OTP', assignee);
    await tickets.complaint(created.id, stallScope(stall), 'WORK_INCOMPLETE', 'The aisle is still blocked', 'case-complaint-note');
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('COMPLAINT_RAISED');
    const activeOtp = await prisma.otpChallenge.count({ where: { ticketId: created.id, invalidatedAt: null, verifiedAt: null } });
    expect(activeOtp).toBe(0);
    const alerts = await prisma.notification.findMany({ where: { ticketId: created.id, type: 'COMPLAINT_RAISED' } });
    expect(alerts.some((alert) => alert.recipientId === manager.id)).toBe(true);
    await expect(workforce.reassign(created.id, worker.id, 'Complaint is not an assignment state', manager.scope)).rejects.toThrow(/cannot be reassigned/);
  });

  it('keeps creation time through retry and closure, and does not call a complaint resolved', async () => {
    const stall = stallsIn(lab, 'H4')[1];
    const manager = lab.managers.find((person) => person.hallId === stall.hallId)!;
    const worker = staffBy(lab, 'H4', 'HOUSE_HELP', 2);
    const started = Date.now();
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Fresh request for timing', 'NORMAL', 'case-age');
    const retried = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Fresh request for timing', 'NORMAL', 'case-age');
    expect(retried.id).toBe(created.id);
    expect(retried.createdAt.toISOString()).toBe(created.createdAt.toISOString());
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(started - 5_000);
    expect(created.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    const newer = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'A later request', 'NORMAL', 'case-age-new');
    expect(newer.id).not.toBe(created.id);
    expect(newer.createdAt.getTime()).toBeGreaterThanOrEqual(created.createdAt.getTime());

    const assignee = staffScope(worker);
    await tickets.transition(created.id, 'ACCEPTED', assignee);
    await tickets.transition(created.id, 'IN_PROGRESS', assignee);
    await tickets.transition(created.id, 'AWAITING_OTP', assignee);
    const waiting = await tickets.list(stallScope(stall), Object.assign(new ListTicketsDto(), { view: 'active', limit: 20 }));
    const awaiting = waiting.items.find((item) => item.id === created.id);
    expect(awaiting?.status).toBe('AWAITING_OTP');
    expect(describeTicketTiming(awaiting!, Date.parse(waiting.serverTime)).facts.some((fact) => fact.label === 'Resolved in')).toBe(false);

    const presented = await tickets.presentOtp(created.id, stallScope(stall));
    const closed = await tickets.verifyOtp(created.id, presented.otp!, manager.scope);
    expect(closed.status).toBe('CLOSED');
    const closedList = await tickets.list(stallScope(stall), Object.assign(new ListTicketsDto(), { view: 'closed', limit: 5 }));
    expect(Number.isFinite(Date.parse(closedList.serverTime))).toBe(true);
    const closedRow = closedList.items.find((item) => item.id === created.id);
    expect(closedRow?.status).toBe('CLOSED');
    const resolvedNow = describeTicketTiming(closedRow!, Date.parse(closedList.serverTime));
    const resolvedLater = describeTicketTiming(closedRow!, Date.parse(closedList.serverTime) + 10 * 86_400_000);
    expect(resolvedNow.facts[0]?.label).toBe('Resolved in');
    expect(resolvedLater).toEqual(resolvedNow);
    expect(Math.floor((closed.closedAt!.getTime() - created.createdAt.getTime()) / 1000)).toBeLessThan(600);
    const activeAfterClose = await tickets.list(stallScope(stall), Object.assign(new ListTicketsDto(), { view: 'active', limit: 20 }));
    expect(activeAfterClose.items.some((item) => item.id === created.id)).toBe(false);

    await tickets.complaint(created.id, stallScope(stall), 'WORK_QUALITY', 'The work did not hold', 'case-age-complaint');
    const complainedList = await tickets.list(stallScope(stall), Object.assign(new ListTicketsDto(), { view: 'active', limit: 20 }));
    const complained = complainedList.items.find((item) => item.id === created.id);
    expect(complained?.status).toBe('COMPLAINT_RAISED');
    expect(complained?.complaintRaisedAt).toBeTruthy();
    const hiddenFromResolved = await tickets.list(stallScope(stall), Object.assign(new ListTicketsDto(), { view: 'closed', limit: 20 }));
    expect(hiddenFromResolved.items.some((item) => item.id === created.id)).toBe(false);
    const complaintTiming = describeTicketTiming(complained!, Date.parse(complainedList.serverTime));
    expect(complaintTiming.facts.map((fact) => fact.label)).toEqual(['Opened', 'Issue reported']);

    const createdAt = complained!.createdAt;
    await tickets.transition(created.id, 'REOPENED', manager.scope, 'Open the request again');
    const persisted = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(persisted.createdAt.toISOString()).toBe(new Date(createdAt).toISOString());
    const ordered = await tickets.list(stallScope(stall), Object.assign(new ListTicketsDto(), { view: 'all', limit: 20 }));
    const olderIndex = ordered.items.findIndex((item) => item.id === created.id);
    const newerIndex = ordered.items.findIndex((item) => item.id === newer.id);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeGreaterThan(olderIndex);
  });

  it('notifies the scoped manager on create and the assignee on assignment', async () => {
    const stall = stallsIn(lab, 'H4')[0];
    const manager = lab.managers.find((person) => person.hallCode === 'H4')!;
    const other = lab.managers.find((person) => person.hallCode === 'H2')!;
    const worker = staffBy(lab, 'H4', 'HOUSE_HELP', 2);
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Manager alert for a new request', 'NORMAL', 'case-alert');
    const createdAlerts = await prisma.notification.findMany({ where: { ticketId: created.id, type: 'TICKET_CREATED' } });
    expect(createdAlerts.map((alert) => alert.recipientId)).toContain(manager.id);
    expect(createdAlerts.map((alert) => alert.recipientId)).not.toContain(other.id);
    expect(createdAlerts.map((alert) => alert.recipientId)).not.toContain(lab.admin.id);
    const assignedAlerts = await prisma.notification.findMany({ where: { ticketId: created.id, type: 'TICKET_ASSIGNED' } });
    expect(assignedAlerts.map((alert) => alert.recipientId)).toContain(worker.id);
    const duplicateKeys = await prisma.notification.groupBy({
      by: ['dedupeKey'],
      where: { ticketId: created.id },
      _count: { _all: true },
    });
    expect(duplicateKeys.every((row) => row._count._all === 1)).toBe(true);
  });

  it('rejects a repeated accept and keeps the ticket identity on retry', async () => {
    const stall = stallsIn(lab, 'H4')[1];
    const worker = staffBy(lab, 'H4', 'HOUSE_HELP', 2);
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Retry the same request safely', 'NORMAL', 'case-retry');
    const again = await tickets.create({
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: 'Retry the same request safely',
      priority: 'NORMAL',
      idempotencyKey: 'case-retry',
    }, stallScope(stall));
    expect(again.id).toBe(created.id);
    const assignee = staffScope(worker);
    const [first, second] = await Promise.allSettled([
      tickets.transition(created.id, 'ACCEPTED', assignee),
      tickets.transition(created.id, 'ACCEPTED', assignee),
    ]);
    const fulfilled = [first, second].filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('ACCEPTED');
    const owners = await prisma.assignment.count({
      where: { ticketId: created.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    });
    expect(owners).toBe(1);
  });

  it('blocks transfer and archive while work is open, then preserves history', async () => {
    const busyStallId = (await prisma.ticket.findUniqueOrThrow({ where: { id: lab.busyTicketIds[0] } })).stallId;
    await expect(management.archiveRegistration(lab.admin.scope, busyStallId, { reason: 'Pack out' })).rejects.toThrow(/unresolved/);
    const suffix = Date.now().toString(36);
    const source = await management.createMaster(lab.admin.scope, 'stall', {
      eventId: lab.eventId,
      zoneId: lab.stalls[0].zoneId,
      stallCode: `CASE-SRC-${suffix}`,
      exhibitorName: 'Case source',
      servicePriority: 'LOW',
    });
    const destination = await management.createMaster(lab.admin.scope, 'stall', {
      eventId: lab.eventId,
      zoneId: lab.stalls[0].zoneId,
      stallCode: `CASE-DST-${suffix}`,
      exhibitorName: 'Case destination',
      servicePriority: 'HIGH',
    });
    await expect(management.createMaster(lab.admin.scope, 'stall', {
      eventId: lab.eventId,
      zoneId: lab.stalls[0].zoneId,
      stallCode: `CASE-SRC-${suffix}`,
      exhibitorName: 'Duplicate',
    })).rejects.toThrow(/CASE-SRC-.*already used in this zone/);
    expect(await prisma.stall.count({ where: { zoneId: lab.stalls[0].zoneId, stallCode: `CASE-SRC-${suffix}` } })).toBe(1);
    await expect(management.updateRegistration(lab.admin.scope, source.id, { exhibitorName: ' ' })).rejects.toThrow(/required/);
    const person = await workforce.createPerson(lab.admin.scope, {
      name: 'Case exhibitor',
      email: `regression.case.${suffix}@volume.lab`,
      password: regressionFixturePassword(),
      role: 'STALL',
      eventId: lab.eventId,
      stallId: source.id,
    });
    await prisma.user.update({ where: { id: person.id }, data: { mustChangePassword: false } });
    const auth = new AuthController(prisma);
    const response = { cookie() { return undefined; } } as unknown as Response;
    await auth.login({ email: `regression.case.${suffix}@volume.lab`, password: regressionFixturePassword(), portal: 'OPERATIONS' }, response);
    const open = await tickets.create({
      category: 'ELECTRICAL',
      subtype: 'Lighting',
      description: 'Open work that blocks a transfer',
      priority: 'NORMAL',
      idempotencyKey: `case-block-${suffix}`,
    }, {
      userId: person.id,
      role: 'STALL',
      eventIds: [lab.eventId],
      hallIds: [lab.stalls[0].hallId],
      stallId: source.id,
      serviceTypes: [],
    });
    await expect(management.transferExhibitor(lab.admin.scope, source.id, { destinationStallId: destination.id, reason: 'Moving booth' })).rejects.toThrow(/unresolved/);
    await prisma.notification.deleteMany({ where: { ticketId: open.id } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: open.id } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: open.id } });
    await prisma.assignment.deleteMany({ where: { ticketId: open.id } });
    await prisma.ticket.delete({ where: { id: open.id } });
    const historical = await prisma.ticket.findUnique({ where: { id: lab.busyTicketIds[0] } });
    await prisma.pushSubscription.create({
      data: { userId: person.id, endpoint: `https://push.example.test/case-${suffix}`, p256dh: 'regression-p256dh-key', auth: 'regression-auth' },
    });
    const unrelated = lab.stalls.find((stall) => stall.userId !== person.id)!;
    await prisma.pushSubscription.create({
      data: { userId: unrelated.userId, endpoint: `https://push.example.test/other-${suffix}`, p256dh: 'regression-p256dh-key', auth: 'regression-auth' },
    });
    const transferred = await management.transferExhibitor(lab.admin.scope, source.id, { destinationStallId: destination.id, reason: 'Moving booth' });
    expect(transferred.destinationStallId).toBe(destination.id);
    const sessions = await prisma.session.count({ where: { userId: person.id } });
    expect(sessions).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { userId: person.id } })).toBe(1);
    const moved = await prisma.userScope.findFirstOrThrow({ where: { userId: person.id, stallId: destination.id } });
    expect(moved.stallId).toBe(destination.id);
    expect(historical?.stallId).toBe(busyStallId);
    if (!historical) throw new Error('Busy ticket missing');
    const sourceNotice = await prisma.notification.create({
      data: {
        eventId: lab.eventId,
        recipientId: person.id,
        ticketId: historical.id,
        type: 'TICKET_CREATED',
        dedupeKey: `case-source-notice-${suffix}`,
        payload: { summary: 'Request from the previous stall' },
      },
    });
    const sent: string[] = [];
    const sender: PushSend = async (subscription) => { sent.push(subscription.userId); };
    await deliverNotificationPush(prisma as never, sourceNotice.id, sender);
    expect(sent).not.toContain(person.id);
    const sourceDelivery = await prisma.notification.findUniqueOrThrow({ where: { id: sourceNotice.id } });
    expect(sourceDelivery.pushedAt).toBeNull();
    expect(sourceDelivery.pushAttempts).toBe(5);
    expect(await prisma.pushSubscription.count({ where: { userId: person.id } })).toBe(1);
    const archived = await management.archiveRegistration(lab.admin.scope, destination.id, { reason: 'Booth left the hall' });
    expect(archived.archivedAt).not.toBeNull();
    const disabled = await prisma.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(disabled.status).toBe('DISABLED');
    expect(await prisma.pushSubscription.count({ where: { userId: person.id } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { userId: unrelated.userId } })).toBe(1);
    expect(await prisma.notification.findUnique({ where: { id: sourceNotice.id } })).not.toBeNull();
    await expect(management.archiveRegistration(lab.admin.scope, destination.id, { reason: 'Booth left the hall' })).rejects.toThrow(/already archived/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).status).toBe('DISABLED');
    await prisma.pushSubscription.create({
      data: { userId: person.id, endpoint: `https://push.example.test/again-${suffix}`, p256dh: 'regression-p256dh-key', auth: 'regression-auth' },
    });
    const disabledNotice = await prisma.notification.create({
      data: {
        eventId: lab.eventId,
        recipientId: person.id,
        type: 'TICKET_CREATED',
        dedupeKey: `case-disabled-notice-${suffix}`,
        payload: { summary: 'Must not be delivered' },
      },
    });
    await deliverNotificationPush(prisma as never, disabledNotice.id, sender);
    expect(sent).not.toContain(person.id);
    expect(await prisma.pushSubscription.count({ where: { userId: person.id } })).toBe(0);
    const kept = await prisma.notification.findUniqueOrThrow({ where: { id: disabledNotice.id } });
    expect(kept.pushedAt).toBeNull();
    expect(kept.pushAttempts).toBe(5);
    await expect(tickets.create({
      category: 'ELECTRICAL',
      subtype: 'Lighting',
      description: 'Archived stall must not accept new work',
      priority: 'NORMAL',
      idempotencyKey: `case-archived-${suffix}`,
    }, {
      userId: person.id,
      role: 'STALL',
      eventIds: [lab.eventId],
      hallIds: [lab.stalls[0].hallId],
      stallId: destination.id,
      serviceTypes: [],
    })).rejects.toThrow(/not active|scope is invalid|unavailable|Invalid/i);
    await prisma.notification.deleteMany({ where: { recipientId: person.id } });
    await prisma.userScope.deleteMany({ where: { userId: person.id } });
    await prisma.session.deleteMany({ where: { userId: person.id } });
    await prisma.pushSubscription.deleteMany({ where: { userId: { in: [person.id, unrelated.userId] }, endpoint: { contains: suffix } } });
    await prisma.user.delete({ where: { id: person.id } });
    await prisma.stall.deleteMany({ where: { id: { in: [source.id, destination.id] } } });
  });

  it('keeps a remaining stall subscription and selects push recipients at dispatch', async () => {
    const suffix = Date.now().toString(36);
    const zoneId = lab.stalls[0].zoneId;
    const hallId = lab.stalls[0].hallId;
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { id: lab.admin.id }, select: { organizationId: true } });
    const keptStall = await management.createMaster(lab.admin.scope, 'stall', {
      eventId: lab.eventId,
      zoneId,
      stallCode: `CASE-KEEP-${suffix}`,
      exhibitorName: 'Kept booth',
      servicePriority: 'LOW',
    });
    const droppedStall = await management.createMaster(lab.admin.scope, 'stall', {
      eventId: lab.eventId,
      zoneId,
      stallCode: `CASE-DROP-${suffix}`,
      exhibitorName: 'Dropped booth',
      servicePriority: 'LOW',
    });
    const person = await prisma.user.create({
      data: {
        organizationId: adminUser.organizationId,
        name: 'Shared exhibitor',
        email: `regression.case.shared.${suffix}@volume.lab`,
        passwordHash: 'not-used',
        role: 'STALL',
        status: 'ACTIVE',
        approvalStatus: 'APPROVED',
      },
    });
    await prisma.userScope.createMany({
      data: [
        { userId: person.id, eventId: lab.eventId, hallId, stallId: keptStall.id },
        { userId: person.id, eventId: lab.eventId, hallId, stallId: droppedStall.id },
      ],
    });
    await prisma.session.create({
      data: { userId: person.id, tokenHash: `shared-session-${suffix}`, expiresAt: new Date(Date.now() + 3600_000) },
    });
    await prisma.pushSubscription.create({
      data: { userId: person.id, endpoint: `https://push.example.test/shared-${suffix}`, p256dh: 'regression-p256dh-key', auth: 'regression-auth' },
    });
    const keptTicket = await prisma.ticket.create({
      data: {
        eventId: lab.eventId,
        publicNo: `CASE-KEEP-${suffix}`,
        hallId,
        zoneId,
        stallId: keptStall.id,
        category: 'ELECTRICAL',
        subtype: 'Lighting',
        description: 'Still this exhibitor',
        status: 'CLOSED',
        createdById: person.id,
        idempotencyKey: `case-keep-${suffix}`,
        closedAt: new Date(),
      },
    });
    const droppedTicket = await prisma.ticket.create({
      data: {
        eventId: lab.eventId,
        publicNo: `CASE-DROP-${suffix}`,
        hallId,
        zoneId,
        stallId: droppedStall.id,
        category: 'ELECTRICAL',
        subtype: 'Lighting',
        description: 'Previous booth',
        status: 'CLOSED',
        createdById: person.id,
        idempotencyKey: `case-drop-${suffix}`,
        closedAt: new Date(),
      },
    });
    await management.archiveRegistration(lab.admin.scope, droppedStall.id, { reason: 'One booth closed' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).status).toBe('ACTIVE');
    expect(await prisma.session.count({ where: { userId: person.id } })).toBe(1);
    expect(await prisma.pushSubscription.count({ where: { userId: person.id } })).toBe(1);
    expect(await prisma.userScope.count({ where: { userId: person.id, stallId: keptStall.id } })).toBe(1);

    const parked = await prisma.notification.findMany({ where: { pushedAt: null }, select: { id: true } });
    if (parked.length) {
      await prisma.notification.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { pushedAt: new Date() } });
    }
    const sent: string[] = [];
    const sender: PushSend = async (subscription) => { sent.push(subscription.id); };
    try {
      const droppedNotice = await prisma.notification.create({
        data: {
          eventId: lab.eventId,
          recipientId: person.id,
          ticketId: droppedTicket.id,
          type: 'TICKET_CREATED',
          dedupeKey: `case-drop-notice-${suffix}`,
          payload: { summary: 'Old booth' },
        },
      });
      const keptNotice = await prisma.notification.create({
        data: {
          eventId: lab.eventId,
          recipientId: person.id,
          ticketId: keptTicket.id,
          type: 'TICKET_CREATED',
          dedupeKey: `case-keep-notice-${suffix}`,
          payload: { summary: 'Current booth' },
        },
      });
      await deliverPendingPushes(prisma as never, sender);
      expect(sent).toHaveLength(1);
      const droppedDelivery = await prisma.notification.findUniqueOrThrow({ where: { id: droppedNotice.id } });
      const keptDelivery = await prisma.notification.findUniqueOrThrow({ where: { id: keptNotice.id } });
      expect(droppedDelivery.pushedAt).toBeNull();
      expect(droppedDelivery.pushAttempts).toBe(5);
      expect(keptDelivery.pushedAt).not.toBeNull();
      expect(await prisma.pushSubscription.count({ where: { userId: person.id } })).toBe(1);
      sent.length = 0;
      await deliverPendingPushes(prisma as never, sender);
      expect(sent).toHaveLength(0);

      const assignee = await prisma.assignment.findFirstOrThrow({
        where: { ticketId: lab.busyTicketIds[0], status: { in: ['ACTIVE', 'ACCEPTED'] } },
        include: { ticket: true },
      });
      const bystander = lab.staff.find((row) => row.id !== assignee.staffId && row.hallId === assignee.ticket.hallId && row.kind === assignee.ticket.category)!;
      await prisma.pushSubscription.create({
        data: { userId: assignee.staffId, endpoint: `https://push.example.test/staff-${suffix}`, p256dh: 'regression-p256dh-key', auth: 'regression-auth' },
      });
      await prisma.pushSubscription.create({
        data: { userId: bystander.id, endpoint: `https://push.example.test/bystander-${suffix}`, p256dh: 'regression-p256dh-key', auth: 'regression-auth' },
      });
      const assignedNotice = await prisma.notification.create({
        data: {
          eventId: assignee.ticket.eventId,
          recipientId: assignee.staffId,
          ticketId: assignee.ticketId,
          type: 'TICKET_ASSIGNED',
          dedupeKey: `case-assignee-${suffix}`,
          payload: { summary: 'Your task' },
        },
      });
      const staleNotice = await prisma.notification.create({
        data: {
          eventId: assignee.ticket.eventId,
          recipientId: bystander.id,
          ticketId: assignee.ticketId,
          type: 'TICKET_ASSIGNED',
          dedupeKey: `case-bystander-${suffix}`,
          payload: { summary: 'Not your task' },
        },
      });
      await deliverPendingPushes(prisma as never, sender);
      expect(sent).toHaveLength(1);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: assignedNotice.id } })).pushedAt).not.toBeNull();
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: staleNotice.id } })).pushAttempts).toBe(5);
      expect(await prisma.pushSubscription.count({ where: { userId: bystander.id, endpoint: { contains: suffix } } })).toBe(1);
    } finally {
      if (parked.length) {
        await prisma.notification.updateMany({ where: { id: { in: parked.map((row) => row.id) } }, data: { pushedAt: null } });
      }
      await prisma.notification.deleteMany({ where: { dedupeKey: { contains: suffix } } });
      await prisma.pushSubscription.deleteMany({ where: { endpoint: { contains: suffix } } });
    }
  });

  it('maps duplicate stall codes to a conflict through HTTP', async () => {
    const suffix = Date.now().toString(36);
    const zoneId = lab.stalls[0].zoneId;
    const adminCookie = await sessionCookie(prisma, lab.admin.id);
    const code = `CASE-HTTP-${suffix}`;
    const createStall = (stallCode: string, exhibitorName: string) => api(baseUrl, '/api/management/masters/stall', adminCookie, {
      method: 'POST',
      body: JSON.stringify({ eventId: lab.eventId, zoneId, stallCode, exhibitorName }),
    });
    const missing = await api(baseUrl, '/api/management/masters/stall', adminCookie, {
      method: 'POST',
      body: JSON.stringify({ eventId: lab.eventId, zoneId, stallCode: `CASE-HTTP-BAD-${suffix}` }),
    });
    expect(missing.status).toBe(400);

    const first = await createStall(code, 'First booth');
    expect(first.status).toBe(201);
    const duplicate = await createStall(code, 'Second booth');
    expect(duplicate.status).toBe(409);
    expect(JSON.stringify(await duplicate.json())).toContain(code);
    expect(await prisma.stall.count({ where: { zoneId, stallCode: code } })).toBe(1);
    expect(await prisma.stall.count({ where: { exhibitorName: 'Second booth' } })).toBe(0);

    const otherCode = `CASE-HTTP-B-${suffix}`;
    const other = await createStall(otherCode, 'Other booth');
    expect(other.status).toBe(201);
    const otherRow = await other.json() as { id: string };
    const edited = await api(baseUrl, `/api/management/registrations/${otherRow.id}`, adminCookie, {
      method: 'PATCH',
      body: JSON.stringify({ stallCode: code }),
    });
    expect(edited.status).toBe(409);
    expect(JSON.stringify(await edited.json())).toContain(code);
    expect((await prisma.stall.findUniqueOrThrow({ where: { id: otherRow.id } })).stallCode).toBe(otherCode);

    const raceCode = `CASE-HTTP-RACE-${suffix}`;
    const [left, right] = await Promise.all([
      createStall(raceCode, 'Race left'),
      createStall(raceCode, 'Race right'),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    expect(await prisma.stall.count({ where: { zoneId, stallCode: raceCode } })).toBe(1);
    const loser = left.status === 409 ? 'Race left' : 'Race right';
    expect(await prisma.stall.count({ where: { exhibitorName: loser } })).toBe(0);

    const validCode = `CASE-HTTP-OK-${suffix}`;
    const valid = await createStall(validCode, 'Valid booth');
    expect(valid.status).toBe(201);
    expect(await prisma.stall.count({ where: { zoneId, stallCode: validCode } })).toBe(1);
  });

  it('returns the assigned ticket and still notifies when reopen has capacity', async () => {
    const stall = stallsIn(lab, 'H4')[0];
    const manager = lab.managers.find((person) => person.hallId === stall.hallId)!;
    const worker = staffBy(lab, 'H4', 'HOUSE_HELP', 2);
    const other = staffBy(lab, 'H4', 'HOUSE_HELP', 1);
    await workforce.availability(staffScope(other), 'OFF_DUTY');
    await workforce.availability(staffScope(worker), 'ON_DUTY');
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Reopen with a free worker', 'NORMAL', 'case-reopen-free');
    expect(created.status).toBe('ASSIGNED');
    await closeThroughOtp(tickets, created.id, worker, stall, manager.scope);
    const before = await prisma.notification.count({ where: { ticketId: created.id, type: 'TICKET_REOPENED' } });
    const reopened = await tickets.transition(created.id, 'REOPENED', manager.scope, 'The work was incomplete');
    const persisted = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(persisted.status).toBe('ASSIGNED');
    expect(reopened.status).toBe('ASSIGNED');
    expect(reopened.id).toBe(persisted.id);
    expect(reopened.reopenCount).toBe(1);
    expect(await prisma.assignment.count({
      where: { ticketId: created.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    })).toBe(1);
    const alerts = await prisma.notification.findMany({ where: { ticketId: created.id, type: 'TICKET_REOPENED' } });
    expect(alerts.length).toBeGreaterThan(before);
    expect(alerts.some((alert) => alert.recipientId === stall.userId)).toBe(true);
    await expect(tickets.transition(created.id, 'REOPENED', manager.scope, 'The work was incomplete')).rejects.toThrow(/Invalid ticket transition/);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } })).reopenCount).toBe(1);
  });

  it('returns the queued ticket and still notifies when reopen has no capacity', async () => {
    const stall = stallsIn(lab, 'H4')[1];
    const manager = lab.managers.find((person) => person.hallId === stall.hallId)!;
    const worker = staffBy(lab, 'H4', 'HOUSE_HELP', 2);
    const other = staffBy(lab, 'H4', 'HOUSE_HELP', 1);
    await workforce.availability(staffScope(other), 'OFF_DUTY');
    await workforce.availability(staffScope(worker), 'ON_DUTY');
    const created = await createCase(tickets, stall, 'HOUSE_HELP', 'General', 'Reopen with nobody free', 'NORMAL', 'case-reopen-busy');
    expect(created.status).toBe('ASSIGNED');
    await closeThroughOtp(tickets, created.id, worker, stall, manager.scope);
    await workforce.availability(staffScope(worker), 'OFF_DUTY');
    const reopened = await tickets.transition(created.id, 'REOPENED', manager.scope, 'Nobody is free');
    const persisted = await prisma.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(persisted.status).toBe('QUEUED');
    expect(reopened.status).toBe('QUEUED');
    expect(await prisma.assignment.count({
      where: { ticketId: created.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    })).toBe(0);
    const alerts = await prisma.notification.findMany({ where: { ticketId: created.id, type: 'TICKET_REOPENED' } });
    expect(alerts.some((alert) => alert.recipientId === stall.userId)).toBe(true);
    expect(alerts.some((alert) => alert.recipientId === manager.id)).toBe(false);
  });

  it('hides operational fields from stall and staff, and issues one retry-safe exhibitor login', async () => {
    const stall = stallsIn(lab, 'H1')[0];
    const created = await createCase(tickets, stall, 'ELECTRICAL', 'NCP', 'Audience check', 'NORMAL', 'case-audience');
    const assignment = await prisma.assignment.findFirst({ where: { ticketId: created.id, status: { in: ['ACTIVE', 'ACCEPTED'] } } });
    const worker = lab.staff.find((person) => person.id === assignment?.staffId);
    if (worker) {
      const staffDetail = await tickets.detail(created.id, staffScope(worker));
      expect(staffDetail).not.toHaveProperty('slaState');
      expect(staffDetail).not.toHaveProperty('pool');
      expect(staffDetail).not.toHaveProperty('servicePriority');
      expect(staffDetail).not.toHaveProperty('assignments');
      expect(staffDetail).toHaveProperty('taskLabel');
    }
    const stallDetail = await tickets.detail(created.id, stallScope(stall));
    expect(stallDetail).not.toHaveProperty('slaState');
    expect(stallDetail).not.toHaveProperty('events');
    expect(stallDetail).not.toHaveProperty('otpChallenges');
    expect(stallDetail).not.toHaveProperty('servicePriority');
    expect((stallDetail as { progressLabel?: string }).progressLabel).toBe('Staff assigned');
    const activity = await tickets.activity(created.id, stallScope(stall));
    expect(activity.items.every((item) => !('eventType' in item) && 'summary' in item)).toBe(true);
    const managerDetail = await tickets.detail(created.id, lab.managers.find((person) => person.hallId === stall.hallId)!.scope);
    expect(managerDetail).toHaveProperty('slaState');
    expect(managerDetail).toHaveProperty('servicePriority');

    const email = `regression.case.login.${Date.now()}@volume.lab`;
    const key = `case-login-${Date.now()}`;
    const body = {
      eventId: lab.eventId,
      zoneId: stall.zoneId,
      stallCode: 'CASE-LOGIN',
      exhibitorName: 'Case login',
      servicePriority: 'HIGH' as const,
      loginName: 'Case login',
      loginEmail: email,
      idempotencyKey: key,
    };
    const first = await management.createRegistrationWithLogin(lab.admin.scope, body);
    const retry = await management.createRegistrationWithLogin(lab.admin.scope, body);
    expect(first.credentialIssued).toBe(true);
    expect(first.handoff.initialCredential).toEqual(expect.any(String));
    expect(retry.credentialIssued).toBe(false);
    expect(retry.handoff.initialCredential).toBeNull();
    expect(await prisma.stall.count({ where: { stallCode: 'CASE-LOGIN', zoneId: stall.zoneId } })).toBe(1);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    const audits = await prisma.managementAudit.findMany({ where: { targetUserId: first.account.id } });
    expect(JSON.stringify(audits)).not.toContain(first.handoff.initialCredential);
    const auth = new AuthController(prisma);
    const response = { cookie() { return undefined; } } as unknown as Response;
    const signedIn = await auth.login({
      email,
      password: first.handoff.initialCredential!,
      portal: 'OPERATIONS',
    }, response);
    expect(signedIn.mustChangePassword).toBe(true);
    const changed = await auth.changePassword(
      { userId: first.account.id, role: 'STALL', eventIds: [lab.eventId], hallIds: [stall.hallId], stallId: first.registration?.id, serviceTypes: [] },
      { currentPassword: first.handoff.initialCredential!, newPassword: 'Replacement!2026' },
      { sessionId: undefined } as never,
    );
    expect(changed.mustChangePassword).toBe(false);
  });
});

if (!isolated) {
  // Avoid silently exercising the developer database when this suite is collected with the default .env.
  console.warn('Skipping 40-user regression lab because DATABASE_URL is not a localhost eveops_regression database.');
}

function hall4(lab: RegressionFixture) {
  const manager = lab.managers.find((person) => person.hallCode === 'H4');
  if (!manager) throw new Error('Hall 4 manager missing');
  return { manager };
}

function staffBy(lab: RegressionFixture, hallCode: string, kind: RegressionStaff['kind'], slot: 1 | 2) {
  const person = lab.staff.find((row) => row.hallCode === hallCode && row.kind === kind && row.slot === slot);
  if (!person) throw new Error(`Missing ${kind} ${hallCode}.${slot}`);
  return person;
}

function stallsIn(lab: RegressionFixture, hallCode: string) {
  return lab.stalls.filter((stall) => stall.hallCode === hallCode);
}

function stallScope(stall: RegressionStall) {
  return {
    userId: stall.userId,
    role: 'STALL' as const,
    eventIds: ['regression-event'],
    hallIds: [stall.hallId],
    stallId: stall.id,
    serviceTypes: [],
  };
}

function otherStallScope(stall: RegressionStall) {
  return stallScope(stall);
}

function staffScope(person: RegressionStaff) {
  return {
    userId: person.id,
    role: 'STAFF' as const,
    eventIds: ['regression-event'],
    hallIds: [person.hallId],
    serviceTypes: [person.kind],
  };
}

async function closeThroughOtp(
  tickets: TicketService,
  ticketId: string,
  worker: RegressionStaff,
  stall: RegressionStall,
  manager: RegressionFixture['managers'][number]['scope'],
) {
  const assignee = staffScope(worker);
  await tickets.transition(ticketId, 'ACCEPTED', assignee);
  await tickets.transition(ticketId, 'IN_PROGRESS', assignee);
  await tickets.transition(ticketId, 'AWAITING_OTP', assignee);
  const presented = await tickets.presentOtp(ticketId, stallScope(stall));
  if (!presented.otp) throw new Error('OTP was not presented');
  return tickets.verifyOtp(ticketId, presented.otp, manager);
}

async function createCase(
  tickets: TicketService,
  stall: RegressionStall,
  category: 'ELECTRICAL' | 'HOUSE_HELP',
  subtype: string,
  description: string,
  priority: 'NORMAL' | 'URGENT',
  idempotencyKey: string,
) {
  return tickets.create({ category, subtype, description, priority, idempotencyKey }, stallScope(stall));
}

async function removeCaseTickets(prisma: PrismaService) {
  const rows = await prisma.ticket.findMany({
    where: { idempotencyKey: { startsWith: 'case-' } },
    select: { id: true },
  });
  const ids = rows.map((row) => row.id);
  if (!ids.length) return;
  await prisma.notification.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.complaint.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.otpChallenge.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.assignment.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.ticket.deleteMany({ where: { id: { in: ids } } });
}

async function removeCasePeople(prisma: PrismaService) {
  const people = await prisma.user.findMany({
    where: { email: { startsWith: 'regression.case.' } },
    select: { id: true },
  });
  const ids = people.map((person) => person.id);
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { recipientId: { in: ids } } });
    await prisma.managementAudit.deleteMany({ where: { targetUserId: { in: ids } } });
    await prisma.userScope.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.pushSubscription.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.stall.deleteMany({ where: { stallCode: { startsWith: 'CASE-' } } });
}

async function restoreStaff(prisma: PrismaService, lab: RegressionFixture | undefined) {
  if (!lab) return;
  for (const person of lab.staff.filter((row) => row.hallCode === 'H3' || row.hallCode === 'H4')) {
    await prisma.workforceMembership.updateMany({
      where: { userId: person.id },
      data: { availability: person.availability, capacity: 1 },
    });
  }
  const source = lab.stalls.find((stall) => stall.hallCode === 'H3');
  if (source) {
    await prisma.stall.update({ where: { id: source.id }, data: { servicePriority: source.servicePriority } }).catch(() => undefined);
  }
}

async function sessionCookie(prisma: PrismaService, userId: string) {
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({
    data: {
      userId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return `eveops_session=${token}`;
}

async function login(baseUrl: string, email: string, portal: 'OPERATIONS' | 'GOVERNANCE') {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: regressionFixturePassword(), portal }),
  });
  if (!response.ok) throw new Error(`Login failed with status ${response.status}`);
  const header = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie().join(';')
    : response.headers.get('set-cookie') ?? '';
  const cookie = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('eveops_session='));
  if (!cookie) throw new Error('Login did not return a session cookie');
  return cookie;
}

async function api(baseUrl: string, path: string, cookie: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

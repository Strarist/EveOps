import { createHash } from 'node:crypto';
import type { AuthScope } from '@eveops/contracts';
import { PrismaService } from './prisma.service';
import { ListTicketsDto, TicketService } from './tickets';
import { WorkforceService } from './workforce';
import { ManagementService } from './management';

describe('operational database invariants', () => {
  const prisma = new PrismaService();
  const tickets = new TicketService(prisma);
  const workforce = new WorkforceService(prisma, tickets);
  const management = new ManagementService(prisma);
  const key = `integration-${Date.now()}`;
  const ids = {
    organization: `${key}-org`,
    event: `${key}-event`,
    otherEvent: `${key}-event-other`,
    hall: `${key}-hall`,
    otherHall: `${key}-hall-other`,
    zone: `${key}-zone`,
    stall: `${key}-stall`,
    otherStall: `${key}-stall-other`,
    stallUser: `${key}-stall-user`,
    staffUser: `${key}-staff-user`,
    secondStaffUser: `${key}-staff-user-2`,
    managerUser: `${key}-manager-user`,
    adminUser: `${key}-admin-user`,
    superUser: `${key}-super-user`,
    pool: `${key}-pool`,
    ncpPool: `${key}-ncp-pool`,
    managerPool: `${key}-manager-pool`,
  };
  const stallScope: AuthScope = { userId: ids.stallUser, role: 'STALL', eventIds: [ids.event], hallIds: [ids.hall], stallId: ids.stall, serviceTypes: [] };
  const staffScope: AuthScope = { userId: ids.staffUser, role: 'STAFF', eventIds: [ids.event], hallIds: [ids.hall], serviceTypes: ['ELECTRICAL'] };
  const managerScope: AuthScope = { userId: ids.managerUser, role: 'HALL_MANAGER', eventIds: [ids.event], hallIds: [ids.hall], serviceTypes: [] };
  const adminScope: AuthScope = { userId: ids.adminUser, role: 'ADMIN', eventIds: [ids.event], hallIds: [], serviceTypes: [] };
  const superScope: AuthScope = { userId: ids.superUser, role: 'SUPER_ADMIN', eventIds: [ids.event], hallIds: [], serviceTypes: [] };

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'integration-test-secret-at-least-32-characters';
    process.env.OTP_ENCRYPTION_SECRET = process.env.OTP_ENCRYPTION_SECRET ?? 'integration-otp-secret-at-least-32-characters';
    await prisma.$connect();
    await prisma.organization.create({ data: { id: ids.organization, name: key } });
    await prisma.event.createMany({
      data: [
        { id: ids.event, organizationId: ids.organization, name: 'Integration event', venue: 'Test', startsAt: new Date('2026-01-01'), endsAt: new Date('2027-01-01'), status: 'ACTIVE' },
        { id: ids.otherEvent, organizationId: ids.organization, name: 'Other event', venue: 'Test', startsAt: new Date('2026-01-01'), endsAt: new Date('2027-01-01'), status: 'ACTIVE' },
      ],
    });
    await prisma.hall.createMany({
      data: [
        { id: ids.hall, eventId: ids.event, code: 'H1', name: 'Hall 1' },
        { id: ids.otherHall, eventId: ids.otherEvent, code: 'H2', name: 'Hall 2' },
      ],
    });
    await prisma.zone.create({ data: { id: ids.zone, eventId: ids.event, hallId: ids.hall, code: 'Z1' } });
    await prisma.stall.create({ data: { id: ids.stall, eventId: ids.event, zoneId: ids.zone, stallCode: 'S1', exhibitorName: 'Test stall' } });
    await prisma.stall.create({ data: { id: ids.otherStall, eventId: ids.event, zoneId: ids.zone, stallCode: 'S2', exhibitorName: 'Other stall' } });
    await prisma.user.createMany({
      data: [
        { id: ids.stallUser, organizationId: ids.organization, name: 'Stall', email: `${key}-stall@example.test`, passwordHash: 'not-used', role: 'STALL' },
        { id: ids.staffUser, organizationId: ids.organization, name: 'Staff', email: `${key}-staff@example.test`, passwordHash: 'not-used', role: 'STAFF' },
        { id: ids.secondStaffUser, organizationId: ids.organization, name: 'Second Staff', email: `${key}-staff-2@example.test`, passwordHash: 'not-used', role: 'STAFF' },
        { id: ids.managerUser, organizationId: ids.organization, name: 'Manager', email: `${key}-manager@example.test`, passwordHash: 'not-used', role: 'HALL_MANAGER' },
        { id: ids.adminUser, organizationId: ids.organization, name: 'Admin', email: `${key}-admin@example.test`, passwordHash: 'not-used', role: 'ADMIN' },
        { id: ids.superUser, organizationId: ids.organization, name: 'Super', email: `${key}-super@example.test`, passwordHash: 'not-used', role: 'SUPER_ADMIN' },
      ],
    });
    await prisma.userScope.createMany({
      data: [
        { userId: ids.stallUser, eventId: ids.event, hallId: ids.hall, stallId: ids.stall },
        { userId: ids.staffUser, eventId: ids.event, hallId: ids.hall, serviceType: 'ELECTRICAL' },
        { userId: ids.secondStaffUser, eventId: ids.event, hallId: ids.hall, serviceType: 'ELECTRICAL' },
        { userId: ids.managerUser, eventId: ids.event, hallId: ids.hall },
        { userId: ids.adminUser, eventId: ids.event },
        { userId: ids.superUser, eventId: ids.event },
      ],
    });
    await prisma.servicePool.create({ data: { id: ids.pool, eventId: ids.event, hallId: ids.hall, category: 'ELECTRICAL', subtype: 'Lighting' } });
    await prisma.servicePool.create({ data: { id: ids.ncpPool, eventId: ids.event, hallId: ids.hall, category: 'ELECTRICAL', subtype: 'NCP' } });
    await prisma.servicePool.create({ data: { id: ids.managerPool, eventId: ids.event, hallId: ids.hall, category: 'HALL_MANAGER', subtype: 'General' } });
    await prisma.workforceMembership.create({ data: { eventId: ids.event, poolId: ids.pool, userId: ids.staffUser, availability: 'ON_DUTY', capacity: 1 } });
    await prisma.workforceMembership.create({ data: { eventId: ids.event, poolId: ids.ncpPool, userId: ids.staffUser, availability: 'ON_DUTY', capacity: 1 } });
    await prisma.workforceMembership.create({ data: { eventId: ids.event, poolId: ids.pool, userId: ids.secondStaffUser, availability: 'OFF_DUTY', capacity: 1 } });
    await prisma.workforceMembership.create({ data: { eventId: ids.event, poolId: ids.managerPool, userId: ids.managerUser, availability: 'ON_DUTY', capacity: 1 } });
  });

  afterAll(async () => {
    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.outboxEvent.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.complaint.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.otpChallenge.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.ticketEvent.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.assignment.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.ticket.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.workforceMembership.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.servicePool.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
      prisma.userScope.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } }),
    ]);
    await prisma.stall.deleteMany({ where: { eventId: ids.event } });
    await prisma.zone.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } });
    await prisma.hall.deleteMany({ where: { eventId: { in: [ids.event, ids.otherEvent] } } });
    await prisma.event.deleteMany({ where: { id: { in: [ids.event, ids.otherEvent] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.stallUser, ids.staffUser, ids.secondStaffUser, ids.managerUser, ids.adminUser, ids.superUser] } } });
    await prisma.organization.delete({ where: { id: ids.organization } });
    await prisma.$disconnect();
  });

  function ticketData(id: string, publicNo: string, status: 'NEW' | 'QUEUED' | 'ASSIGNED' | 'SNOOZED' | 'AWAITING_OTP' | 'CLOSED', createdAt: Date) {
    return {
      id,
      publicNo,
      eventId: ids.event,
      hallId: ids.hall,
      zoneId: ids.zone,
      stallId: ids.stall,
      poolId: ids.pool,
      category: 'ELECTRICAL',
      subtype: 'Lighting',
      description: 'Integration test issue',
      status,
      createdById: ids.stallUser,
      idempotencyKey: id,
      createdAt,
    } as const;
  }

  async function releaseActiveAssignments() {
    await prisma.assignment.updateMany({
      where: { eventId: ids.event, status: { in: ['ACTIVE', 'ACCEPTED'] } },
      data: { status: 'RELEASED', activeTicketKey: null, releasedAt: new Date(), releaseReason: 'Concurrency test reset' },
    });
    await prisma.workforceMembership.updateMany({
      where: { poolId: ids.pool },
      data: { availability: 'OFF_DUTY' },
    });
  }

  it('assigns the oldest compatible queued ticket before a fresh ticket', async () => {
    const olderId = `${key}-older`;
    const newerId = `${key}-newer`;
    await prisma.ticket.create({ data: ticketData(olderId, `${key}-001`, 'QUEUED', new Date('2026-06-01T10:00:00Z')) });
    await prisma.ticket.create({ data: ticketData(newerId, `${key}-002`, 'NEW', new Date('2026-06-01T10:01:00Z')) });

    await tickets.route(newerId, ids.stallUser);

    const [older, newer] = await Promise.all([
      prisma.ticket.findUniqueOrThrow({ where: { id: olderId } }),
      prisma.ticket.findUniqueOrThrow({ where: { id: newerId } }),
    ]);
    expect(older.status).toBe('ASSIGNED');
    expect(newer.status).toBe('QUEUED');
    expect(await prisma.assignment.count({ where: { ticketId: olderId, status: { in: ['ACTIVE', 'ACCEPTED'] } } })).toBe(1);
  });

  it('rejects generic snooze by a stall user', async () => {
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { eventId: ids.event, status: 'ASSIGNED' } });
    await expect(tickets.transition(ticket.id, 'SNOOZED', stallScope)).rejects.toThrow('assigned-staff snooze');
  });

  it('does not let a stall list filter override authenticated stall scope', async () => {
    const query = Object.assign(new ListTicketsDto(), { stallId: ids.otherStall });
    await expect(tickets.list(stallScope, query)).rejects.toThrow('outside your scope');
  });

  it('routes a Hall Manager request only to the matching hall manager pool', async () => {
    const ticketId = `${key}-manager-ticket`;
    await prisma.ticket.create({
      data: {
        ...ticketData(ticketId, `${key}-manager-001`, 'NEW', new Date()),
        poolId: ids.managerPool,
        category: 'HALL_MANAGER',
        subtype: 'General',
      },
    });
    await tickets.route(ticketId, undefined, `${key}-manager-correlation`);
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { ticketId } });
    expect(assignment.staffId).toBe(ids.managerUser);
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId, eventType: 'ASSIGNMENT_CREATED' } });
    expect(event.correlationId).toBe(`${key}-manager-correlation`);
    expect(event.actorId).toBeNull();
  });

  it('publishes an outbox invalidation for a reasoned queue priority override', async () => {
    const ticketId = `${key}-priority-ticket`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-priority-001`, 'QUEUED', new Date()) });
    await tickets.prioritizeQueued(ticketId, managerScope, 'Safety-critical stall issue');
    expect(await prisma.outboxEvent.count({ where: { aggregateId: ticketId, eventType: 'QUEUE_PRIORITY_OVERRIDDEN' } })).toBe(1);
  });

  it('completes the assigned staff and stall OTP workflow and dequeues the next ticket', async () => {
    const assigned = await prisma.ticket.findFirstOrThrow({ where: { eventId: ids.event, status: 'ASSIGNED' } });
    await tickets.transition(assigned.id, 'ACCEPTED', staffScope);
    await tickets.transition(assigned.id, 'IN_PROGRESS', staffScope);
    await tickets.transition(assigned.id, 'AWAITING_OTP', staffScope);
    const otp = await tickets.presentOtp(assigned.id, stallScope);
    expect(otp.otp).toMatch(/^\d{6}$/);
    await tickets.verifyOtp(assigned.id, otp.otp as string, staffScope);

    const [closed, next] = await Promise.all([
      prisma.ticket.findUniqueOrThrow({ where: { id: assigned.id }, include: { events: true, assignments: true, otpChallenges: true } }),
      prisma.ticket.findFirstOrThrow({ where: { eventId: ids.event, status: 'ASSIGNED' } }),
    ]);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.events.map((event) => event.eventType)).toEqual(expect.arrayContaining(['STATUS_ACCEPTED', 'STATUS_IN_PROGRESS', 'OTP_GENERATED', 'STATUS_AWAITING_OTP', 'OTP_VERIFIED']));
    expect(closed.assignments).toHaveLength(1);
    expect(closed.otpChallenges).toHaveLength(1);
    expect(next.id).not.toBe(closed.id);
  });

  it('reopens the same ticket identity while preserving its prior cycle', async () => {
    const closed = await prisma.ticket.findFirstOrThrow({ where: { eventId: ids.event, status: 'CLOSED' } });
    const priorPublicNo = closed.publicNo;
    const priorEvents = await prisma.ticketEvent.count({ where: { ticketId: closed.id } });
    await tickets.transition(closed.id, 'REOPENED', managerScope, 'Work requires correction');
    const reopened = await prisma.ticket.findUniqueOrThrow({ where: { id: closed.id } });
    expect(reopened.publicNo).toBe(priorPublicNo);
    expect(['REOPENED', 'QUEUED', 'ASSIGNED']).toContain(reopened.status);
    expect(await prisma.ticketEvent.count({ where: { ticketId: closed.id } })).toBeGreaterThan(priorEvents);
    expect(await prisma.otpChallenge.count({ where: { ticketId: closed.id } })).toBe(1);
  });

  it('invalidates the OTP when a complaint is raised', async () => {
    const ticketId = `${key}-otp`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-003`, 'AWAITING_OTP', new Date()) });
    await prisma.otpChallenge.create({
      data: {
        eventId: ids.event,
        ticketId,
        otpHash: createHash('sha256').update('123456').digest('hex'),
        otpCiphertext: 'not-presented',
        activeTicketKey: ticketId,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    await Promise.all([
      tickets.complaint(ticketId, stallScope, 'WORK_INCOMPLETE', 'Still broken', `${key}-complaint`),
      tickets.complaint(ticketId, stallScope, 'WORK_INCOMPLETE', 'Still broken', `${key}-complaint`),
    ]);
    await expect(tickets.verifyOtp(ticketId, '123456', staffScope)).rejects.toThrow('not awaiting OTP');
    const challenge = await prisma.otpChallenge.findFirstOrThrow({ where: { ticketId } });
    expect(challenge.invalidatedAt).not.toBeNull();
    expect(await prisma.complaint.count({ where: { ticketId } })).toBe(1);
    expect(await prisma.ticketEvent.count({ where: { ticketId, eventType: 'COMPLAINT_RAISED' } })).toBe(1);
  });

  it('does not allow reassignment to revive a closed ticket', async () => {
    const ticketId = `${key}-closed`;
    await prisma.ticket.create({ data: { ...ticketData(ticketId, `${key}-004`, 'CLOSED', new Date()), closedAt: new Date() } });
    await expect(workforce.reassign(ticketId, ids.staffUser, 'Should fail', managerScope)).rejects.toThrow('cannot be reassigned');
  });

  it('rejects cross-event zone hierarchy at the database boundary', async () => {
    await expect(prisma.zone.create({
      data: { id: `${key}-invalid-zone`, eventId: ids.event, hallId: ids.otherHall, code: 'INVALID' },
    })).rejects.toThrow();
  });

  it('serializes scoped timing for Hall Manager and Admin with null milestones', async () => {
    const [managerTiming, adminTiming] = await Promise.all([
      management.timing(managerScope),
      management.timing(adminScope),
    ]);
    expect(managerTiming.every((row) => row.id.includes(key))).toBe(true);
    expect(adminTiming.map((row) => row.id).sort()).toEqual(managerTiming.map((row) => row.id).sort());
    expect(() => JSON.stringify(managerTiming)).not.toThrow();
    expect(managerTiming.some((row) => row.firstAcceptedAt === null)).toBe(true);
  });

  it('scopes governance portfolio and rejects an unauthorized export event', async () => {
    const portfolio = await management.portfolio(superScope);
    expect(portfolio.map((event) => event.id)).toEqual([ids.event]);
    await expect(management.createExport(adminScope, 'CSV', { eventId: ids.otherEvent }, ['publicNo']))
      .rejects.toThrow('Export scope is unavailable');
  });

  it('surfaces a post-closure complaint in management exceptions', async () => {
    const ticketId = `${key}-closed-complaint`;
    await prisma.ticket.create({ data: { ...ticketData(ticketId, `${key}-complaint-closed`, 'CLOSED', new Date()), closedAt: new Date() } });
    const complained = await tickets.complaint(ticketId, stallScope, 'WORK_QUALITY', 'Poor quality after closure', `${key}-closed-complaint-key`);
    expect(complained.status).toBe('COMPLAINT_RAISED');
    const exceptions = await management.exceptions(managerScope);
    expect(exceptions.some((ticket) => ticket.id === ticketId)).toBe(true);
    const metrics = await management.metrics(managerScope);
    expect(metrics.complaints).toBeGreaterThanOrEqual(1);
  });

  it('increments escalation level and records it in audit metadata', async () => {
    const ticketId = `${key}-escalation-level`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-escalation-001`, 'SNOOZED', new Date()) });
    const escalated = await tickets.transition(ticketId, 'ESCALATED', managerScope, 'Manager escalation');
    expect(escalated.escalationLevel).toBe(1);
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId, eventType: 'STATUS_ESCALATED' } });
    expect(event.metadata).toMatchObject({ escalationLevel: 1 });
  });

  it('drains another compatible pool when shared staff capacity is released', async () => {
    await releaseActiveAssignments();
    await prisma.workforceMembership.updateMany({
      where: { userId: ids.staffUser, poolId: { in: [ids.pool, ids.ncpPool] } },
      data: { availability: 'ON_DUTY' },
    });
    const activeId = `${key}-shared-active`;
    const waitingId = `${key}-shared-waiting`;
    await prisma.ticket.create({ data: ticketData(activeId, `${key}-shared-001`, 'AWAITING_OTP', new Date()) });
    await prisma.assignment.create({ data: { eventId: ids.event, ticketId: activeId, staffId: ids.staffUser, status: 'ACCEPTED', activeTicketKey: activeId } });
    await prisma.otpChallenge.create({
      data: {
        eventId: ids.event,
        ticketId: activeId,
        otpHash: createHash('sha256').update('321654').digest('hex'),
        otpCiphertext: 'not-presented',
        activeTicketKey: activeId,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    await prisma.ticket.create({
      data: { ...ticketData(waitingId, `${key}-shared-002`, 'QUEUED', new Date()), poolId: ids.ncpPool, subtype: 'NCP' },
    });
    await tickets.verifyOtp(activeId, '321654', staffScope);
    const waiting = await prisma.ticket.findUniqueOrThrow({ where: { id: waitingId } });
    expect(waiting.status).toBe('ASSIGNED');
  });

  it('allows only one of two simultaneous accepts to commit', async () => {
    await releaseActiveAssignments();
    const ticketId = `${key}-double-accept`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-concurrency-001`, 'ASSIGNED', new Date()) });
    await prisma.assignment.create({ data: { eventId: ids.event, ticketId, staffId: ids.staffUser, status: 'ACTIVE', activeTicketKey: ticketId } });
    const outcomes = await Promise.allSettled([
      tickets.transition(ticketId, 'ACCEPTED', staffScope),
      tickets.transition(ticketId, 'ACCEPTED', staffScope),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.ticketEvent.count({ where: { ticketId, eventType: 'STATUS_ACCEPTED' } })).toBe(1);
  });

  it('deduplicates simultaneous routing of one ticket', async () => {
    await releaseActiveAssignments();
    await prisma.workforceMembership.updateMany({ where: { poolId: ids.pool, userId: ids.staffUser }, data: { availability: 'ON_DUTY' } });
    const ticketId = `${key}-duplicate-route`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-concurrency-002`, 'NEW', new Date()) });
    await Promise.all([
      tickets.route(ticketId, ids.stallUser, `${key}-route-a`),
      tickets.route(ticketId, ids.stallUser, `${key}-route-b`),
    ]);
    expect(await prisma.assignment.count({ where: { ticketId, status: { in: ['ACTIVE', 'ACCEPTED'] } } })).toBeLessThanOrEqual(1);
    expect(await prisma.ticketEvent.count({ where: { ticketId, eventType: { in: ['ASSIGNMENT_CREATED', 'TICKET_QUEUED'] } } })).toBe(1);
  });

  it('serializes OTP verification against a complaint', async () => {
    await releaseActiveAssignments();
    const ticketId = `${key}-otp-complaint-race`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-concurrency-003`, 'AWAITING_OTP', new Date()) });
    await prisma.assignment.create({ data: { eventId: ids.event, ticketId, staffId: ids.staffUser, status: 'ACCEPTED', activeTicketKey: ticketId } });
    await prisma.otpChallenge.create({
      data: {
        eventId: ids.event,
        ticketId,
        otpHash: createHash('sha256').update('654321').digest('hex'),
        otpCiphertext: 'not-presented',
        activeTicketKey: ticketId,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    const outcomes = await Promise.allSettled([
      tickets.verifyOtp(ticketId, '654321', staffScope),
      tickets.complaint(ticketId, stallScope, 'WORK_INCOMPLETE', 'Race test', `${key}-race-complaint`),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const final = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(['CLOSED', 'COMPLAINT_RAISED']).toContain(final.status);
  });

  it('serializes reopen against OTP closure', async () => {
    await releaseActiveAssignments();
    const ticketId = `${key}-reopen-close-race`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-concurrency-003b`, 'AWAITING_OTP', new Date()) });
    await prisma.assignment.create({ data: { eventId: ids.event, ticketId, staffId: ids.staffUser, status: 'ACCEPTED', activeTicketKey: ticketId } });
    await prisma.otpChallenge.create({
      data: {
        eventId: ids.event,
        ticketId,
        otpHash: createHash('sha256').update('456789').digest('hex'),
        otpCiphertext: 'not-presented',
        activeTicketKey: ticketId,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    const outcomes = await Promise.allSettled([
      tickets.verifyOtp(ticketId, '456789', staffScope),
      tickets.transition(ticketId, 'REOPENED', managerScope, 'Concurrent reopen'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const final = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(['CLOSED', 'REOPENED', 'QUEUED', 'ASSIGNED']).toContain(final.status);
  });

  it('allows only stall to present OTP and only assigned staff to verify it', async () => {
    await releaseActiveAssignments();
    await prisma.workforceMembership.updateMany({ where: { userId: ids.staffUser, poolId: ids.pool }, data: { availability: 'ON_DUTY' } });
    const ticketId = `${key}-otp-roles`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-otp-roles-001`, 'ASSIGNED', new Date()) });
    await prisma.assignment.create({ data: { eventId: ids.event, ticketId, staffId: ids.staffUser, status: 'ACTIVE', activeTicketKey: ticketId } });
    await tickets.transition(ticketId, 'ACCEPTED', staffScope);
    await tickets.transition(ticketId, 'IN_PROGRESS', staffScope);
    await tickets.transition(ticketId, 'AWAITING_OTP', staffScope);
    const presented = await tickets.presentOtp(ticketId, stallScope);
    expect(presented.otp).toMatch(/^\d{6}$/);
    await expect(tickets.presentOtp(ticketId, staffScope)).rejects.toThrow(/bound stall|Forbidden/i);
    await expect(tickets.verifyOtp(ticketId, presented.otp!, stallScope)).rejects.toThrow(/assigned staff|Forbidden/i);
    await tickets.verifyOtp(ticketId, presented.otp!, staffScope);
    const closed = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(closed.status).toBe('CLOSED');
    await expect(tickets.presentOtp(ticketId, stallScope)).rejects.toThrow(/already verified|not awaiting/i);
  });

  it('preserves one active assignee during reassign versus accept', async () => {
    await releaseActiveAssignments();
    await prisma.workforceMembership.updateMany({ where: { poolId: ids.pool }, data: { availability: 'ON_DUTY' } });
    const ticketId = `${key}-reassign-accept-race`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-concurrency-004`, 'ASSIGNED', new Date()) });
    await prisma.assignment.create({ data: { eventId: ids.event, ticketId, staffId: ids.staffUser, status: 'ACTIVE', activeTicketKey: ticketId } });
    await Promise.allSettled([
      tickets.transition(ticketId, 'ACCEPTED', staffScope),
      workforce.reassign(ticketId, ids.secondStaffUser, 'Concurrent reassignment', managerScope),
    ]);
    expect(await prisma.assignment.count({ where: { ticketId, status: { in: ['ACTIVE', 'ACCEPTED'] } } })).toBe(1);
  });

  it('keeps availability and routing linearizable', async () => {
    await releaseActiveAssignments();
    await prisma.workforceMembership.updateMany({ where: { poolId: ids.pool, userId: ids.staffUser }, data: { availability: 'ON_DUTY' } });
    const ticketId = `${key}-availability-route-race`;
    await prisma.ticket.create({ data: ticketData(ticketId, `${key}-concurrency-005`, 'NEW', new Date()) });
    await Promise.allSettled([
      tickets.route(ticketId, ids.stallUser, `${key}-availability-route`),
      workforce.availability(staffScope, 'PAUSED'),
    ]);
    expect(await prisma.assignment.count({ where: { ticketId, status: { in: ['ACTIVE', 'ACCEPTED'] } } })).toBeLessThanOrEqual(1);
  });

  it('allows only one worker claim for an outbox row', async () => {
    const outbox = await prisma.outboxEvent.create({
      data: { eventId: ids.event, aggregateType: 'Ticket', aggregateId: `${key}-claim`, eventType: 'TEST_CLAIM', payload: {} },
    });
    const claim = (owner: string) => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${outbox.id}, 9))`;
      return tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "OutboxEvent"
        SET "lockedAt" = NOW(), "lockOwner" = ${owner}, attempts = attempts + 1
        WHERE id = ${outbox.id} AND "processedAt" IS NULL AND "lockedAt" IS NULL
        RETURNING id
      `;
    });
    const claims = await Promise.all([claim('worker-a'), claim('worker-b')]);
    expect(claims.flat()).toHaveLength(1);
  });
});

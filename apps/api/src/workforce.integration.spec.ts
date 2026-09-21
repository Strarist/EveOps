import { ForbiddenException } from '@nestjs/common';
import type { AuthScope } from '@eveops/contracts';
import { hash } from 'bcryptjs';
import { AuthController } from './auth';
import { PrismaService } from './prisma.service';
import { TicketService } from './tickets';
import { AvailabilityDto, CreatePersonDto, WorkforceService } from './workforce';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

describe('workforce identity management', () => {
  const prisma = new PrismaService();
  const tickets = new TicketService(prisma);
  const workforce = new WorkforceService(prisma, tickets);
  const auth = new AuthController(prisma);
  const key = `workforce-${Date.now()}`;
  const ids = {
    organization: `${key}-org`,
    event: `${key}-event`,
    hall: `${key}-hall`,
    otherHall: `${key}-hall-other`,
    zone: `${key}-zone`,
    otherZone: `${key}-zone-other`,
    stall: `${key}-stall`,
    staffUser: `${key}-staff-user`,
    managerUser: `${key}-manager-user`,
    adminUser: `${key}-admin-user`,
    housePool: `${key}-house-pool`,
    otherHousePool: `${key}-other-house-pool`,
    elecPool: `${key}-elec-pool`,
    managerPool: `${key}-manager-pool`,
  };
  const password = 'WorkforceDemo!2026';
  let passwordHash = '';

  const staffScope: AuthScope = {
    userId: ids.staffUser,
    role: 'STAFF',
    eventIds: [ids.event],
    hallIds: [ids.hall],
    serviceTypes: ['ELECTRICAL'],
  };
  const managerScope: AuthScope = {
    userId: ids.managerUser,
    role: 'HALL_MANAGER',
    eventIds: [ids.event],
    hallIds: [ids.hall],
    serviceTypes: [],
  };
  const adminScope: AuthScope = {
    userId: ids.adminUser,
    role: 'ADMIN',
    eventIds: [ids.event],
    hallIds: [],
    serviceTypes: [],
  };

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'integration-test-secret-at-least-32-characters';
    process.env.OTP_ENCRYPTION_SECRET = process.env.OTP_ENCRYPTION_SECRET ?? 'integration-otp-secret-at-least-32-characters';
    passwordHash = await hash(password, 12);
    await prisma.$connect();
    await prisma.organization.create({ data: { id: ids.organization, name: key } });
    await prisma.event.create({
      data: {
        id: ids.event,
        organizationId: ids.organization,
        name: 'Workforce event',
        venue: 'Test',
        startsAt: new Date('2026-01-01'),
        endsAt: new Date('2027-01-01'),
        status: 'ACTIVE',
      },
    });
    await prisma.hall.createMany({
      data: [
        { id: ids.hall, eventId: ids.event, code: 'H1', name: 'Hall 1' },
        { id: ids.otherHall, eventId: ids.event, code: 'H2', name: 'Hall 2' },
      ],
    });
    await prisma.zone.createMany({
      data: [
        { id: ids.zone, eventId: ids.event, hallId: ids.hall, code: 'Z1' },
        { id: ids.otherZone, eventId: ids.event, hallId: ids.otherHall, code: 'Z2' },
      ],
    });
    await prisma.stall.create({
      data: { id: ids.stall, eventId: ids.event, zoneId: ids.zone, stallCode: 'S1', exhibitorName: 'Test stall' },
    });
    await prisma.user.createMany({
      data: [
        {
          id: ids.staffUser,
          organizationId: ids.organization,
          name: 'Staff',
          email: `${key}-staff@example.test`,
          passwordHash,
          role: 'STAFF',
          employeeCode: 'STF-TEST-01',
        },
        {
          id: ids.managerUser,
          organizationId: ids.organization,
          name: 'Manager',
          email: `${key}-manager@example.test`,
          passwordHash,
          role: 'HALL_MANAGER',
          employeeCode: 'HM-TEST-01',
        },
        {
          id: ids.adminUser,
          organizationId: ids.organization,
          name: 'Admin',
          email: `${key}-admin@example.test`,
          passwordHash,
          role: 'ADMIN',
          employeeCode: 'ADM-TEST-01',
        },
      ],
    });
    await prisma.userScope.createMany({
      data: [
        { userId: ids.staffUser, eventId: ids.event, hallId: ids.hall, serviceType: 'ELECTRICAL' },
        { userId: ids.managerUser, eventId: ids.event, hallId: ids.hall },
        { userId: ids.adminUser, eventId: ids.event },
      ],
    });
    await prisma.servicePool.createMany({
      data: [
        { id: ids.elecPool, eventId: ids.event, hallId: ids.hall, category: 'ELECTRICAL', subtype: 'Lighting' },
        { id: ids.housePool, eventId: ids.event, hallId: ids.hall, category: 'HOUSE_HELP', subtype: 'General' },
        { id: ids.otherHousePool, eventId: ids.event, hallId: ids.otherHall, category: 'HOUSE_HELP', subtype: 'General' },
        { id: ids.managerPool, eventId: ids.event, hallId: ids.hall, category: 'HALL_MANAGER', subtype: 'General' },
      ],
    });
    await prisma.workforceMembership.createMany({
      data: [
        { eventId: ids.event, poolId: ids.elecPool, userId: ids.staffUser, availability: 'OFF_DUTY', capacity: 1 },
        { eventId: ids.event, poolId: ids.managerPool, userId: ids.managerUser, availability: 'ON_DUTY', capacity: 1 },
      ],
    });
  });

  afterAll(async () => {
    const userIds = [ids.staffUser, ids.managerUser, ids.adminUser, ...createdUserIds];
    await prisma.$transaction([
      prisma.managementAudit.deleteMany({ where: { organizationId: ids.organization } }),
      prisma.session.deleteMany({ where: { userId: { in: userIds } } }),
      prisma.notification.deleteMany({ where: { eventId: ids.event } }),
      prisma.outboxEvent.deleteMany({ where: { eventId: ids.event } }),
      prisma.assignment.deleteMany({ where: { eventId: ids.event } }),
      prisma.ticketEvent.deleteMany({ where: { eventId: ids.event } }),
      prisma.ticket.deleteMany({ where: { eventId: ids.event } }),
      prisma.workforceMembership.deleteMany({ where: { eventId: ids.event } }),
      prisma.servicePool.deleteMany({ where: { eventId: ids.event } }),
      prisma.userScope.deleteMany({ where: { eventId: ids.event } }),
    ]);
    await prisma.stall.deleteMany({ where: { eventId: ids.event } });
    await prisma.zone.deleteMany({ where: { eventId: ids.event } });
    await prisma.hall.deleteMany({ where: { eventId: ids.event } });
    await prisma.event.deleteMany({ where: { id: ids.event } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.organization.delete({ where: { id: ids.organization } });
    await prisma.$disconnect();
  });

  it('allows Hall Manager to create House Help staff in own hall as pending approval without person ID', async () => {
    const created = await workforce.createPerson(managerScope, {
      name: 'House Helper',
      email: `${key}-house@example.test`,
      password,
      role: 'STAFF',
      eventId: ids.event,
      hallId: ids.hall,
      serviceCategory: 'HOUSE_HELP',
      serviceSubtype: 'General',
    } as CreatePersonDto);
    createdUserIds.push(created.id);
    expect(created.role).toBe('STAFF');
    expect(created.employeeCode).toBeNull();
    expect(created.approvalStatus).toBe('PENDING_APPROVAL');
    const membership = await prisma.workforceMembership.findFirst({
      where: { userId: created.id, poolId: ids.housePool },
    });
    expect(membership).toBeTruthy();
    const audit = await prisma.managementAudit.findFirst({
      where: { targetUserId: created.id, action: 'STAFF_APPROVAL_REQUESTED' },
    });
    expect(audit).toBeTruthy();
  });

  it('forbids Hall Manager from assigning public person IDs', async () => {
    await expect(
      workforce.createPerson(managerScope, {
        name: 'Coded Staff',
        email: `${key}-coded@example.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        hallId: ids.hall,
        serviceCategory: 'HOUSE_HELP',
        serviceSubtype: 'General',
        employeeCode: 'HELP-HOUSE-T1',
      } as CreatePersonDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids Hall Manager from creating staff in another hall', async () => {
    await expect(
      workforce.createPerson(managerScope, {
        name: 'Other Hall Staff',
        email: `${key}-other-hall@example.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        hallId: ids.otherHall,
        serviceCategory: 'HOUSE_HELP',
        serviceSubtype: 'General',
      } as CreatePersonDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids Hall Manager from creating ADMIN', async () => {
    await expect(
      workforce.createPerson(managerScope, {
        name: 'Should Fail Admin',
        email: `${key}-bad-admin@example.test`,
        password,
        role: 'ADMIN',
        eventId: ids.event,
      } as CreatePersonDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('forbids Hall Manager from creating HALL_MANAGER', async () => {
    await expect(
      workforce.createPerson(managerScope, {
        name: 'Should Fail Manager',
        email: `${key}-bad-hm@example.test`,
        password,
        role: 'HALL_MANAGER',
        eventId: ids.event,
        hallId: ids.hall,
      } as CreatePersonDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows Admin to create approved staff immediately', async () => {
    const created = await workforce.createPerson(adminScope, {
      name: 'Admin Created Staff',
      email: `${key}-admin-staff@example.test`,
      password,
      role: 'STAFF',
      eventId: ids.event,
      hallId: ids.otherHall,
      serviceCategory: 'HOUSE_HELP',
      serviceSubtype: 'General',
    } as CreatePersonDto);
    createdUserIds.push(created.id);
    expect(created.approvalStatus).toBe('APPROVED');
    expect(created.employeeCode).toMatch(/^HELP-\d{4}$/);
    const scope = await prisma.userScope.findFirst({ where: { userId: created.id } });
    expect(scope?.hallId).toBe(ids.otherHall);
  });

  it('lets Admin approve Hall Manager pending staff and blocks routing while pending', async () => {
    const created = await workforce.createPerson(managerScope, {
      name: 'Pending Electrician',
      email: `${key}-pending-elec@example.test`,
      password,
      role: 'STAFF',
      eventId: ids.event,
      hallId: ids.hall,
      serviceCategory: 'ELECTRICAL',
      serviceSubtype: 'Lighting',
    } as CreatePersonDto);
    createdUserIds.push(created.id);
    expect(created.approvalStatus).toBe('PENDING_APPROVAL');
    expect(created.employeeCode).toBeNull();
    const pending = await workforce.listPending(adminScope);
    expect(pending.some((person) => person.id === created.id)).toBe(true);
    const approved = await workforce.approvePerson(adminScope, created.id);
    expect(approved.approvalStatus).toBe('APPROVED');
    expect(approved.employeeCode).toMatch(/^ELEC-\d{4}$/);
    await expect(workforce.approvePerson(adminScope, created.id)).rejects.toThrow(/already been reviewed/i);
  });

  it('lets Admin reject pending staff with a reason', async () => {
    const created = await workforce.createPerson(managerScope, {
      name: 'Rejected Helper',
      email: `${key}-rejected@example.test`,
      password,
      role: 'STAFF',
      eventId: ids.event,
      hallId: ids.hall,
      serviceCategory: 'HOUSE_HELP',
      serviceSubtype: 'General',
    } as CreatePersonDto);
    createdUserIds.push(created.id);
    const rejected = await workforce.rejectPerson(adminScope, created.id, 'Incomplete paperwork');
    expect(rejected.approvalStatus).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('Incomplete paperwork');
  });

  it('denies pending approval login with a clear message', async () => {
    const created = await workforce.createPerson(managerScope, {
      name: 'Pending Login',
      email: `${key}-pending-login@example.test`,
      password,
      role: 'STAFF',
      eventId: ids.event,
      hallId: ids.hall,
      serviceCategory: 'ELECTRICAL',
      serviceSubtype: 'Lighting',
    } as CreatePersonDto);
    createdUserIds.push(created.id);
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    await expect(
      auth.login({ email: `${key}-pending-login@example.test`, password, portal: 'OPERATIONS' }, response as never),
    ).rejects.toThrow(/awaiting Admin approval/i);
  });

  it('forbids Staff from creating users', async () => {
    await expect(
      workforce.createPerson(staffScope, {
        name: 'Staff Created',
        email: `${key}-staff-create@example.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        hallId: ids.hall,
        serviceCategory: 'HOUSE_HELP',
        serviceSubtype: 'General',
      } as CreatePersonDto),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('validates availability DTO and toggles ON_DUTY ↔ PAUSED without releasing assignments', async () => {
    const invalid = plainToInstance(AvailabilityDto, { value: 'OFFLINE' });
    const invalidErrors = await validate(invalid);
    expect(invalidErrors.length).toBeGreaterThan(0);

    const valid = plainToInstance(AvailabilityDto, { value: 'ON_DUTY' });
    expect(await validate(valid)).toHaveLength(0);

    const ticketId = `${key}-active-assignment`;
    await prisma.ticket.create({
      data: {
        id: ticketId,
        publicNo: `${key}-001`,
        eventId: ids.event,
        hallId: ids.hall,
        zoneId: ids.zone,
        stallId: ids.stall,
        poolId: ids.elecPool,
        category: 'ELECTRICAL',
        subtype: 'Lighting',
        description: 'Keep assignment',
        status: 'ASSIGNED',
        createdById: ids.adminUser,
        idempotencyKey: ticketId,
      },
    });
    await prisma.assignment.create({
      data: {
        eventId: ids.event,
        ticketId,
        staffId: ids.staffUser,
        status: 'ACTIVE',
        activeTicketKey: ticketId,
      },
    });

    const onDuty = await workforce.availability(staffScope, 'ON_DUTY');
    expect(onDuty.availability).toBe('ON_DUTY');
    const paused = await workforce.availability(staffScope, 'PAUSED');
    expect(paused.availability).toBe('PAUSED');
    expect(await prisma.assignment.count({ where: { ticketId, status: 'ACTIVE' } })).toBe(1);
  });

  it('forces password rotation before operations after staff create', async () => {
    const created = await workforce.createPerson(adminScope, {
      name: 'Rotate Me',
      email: `${key}-rotate@example.test`,
      password,
      role: 'STAFF',
      eventId: ids.event,
      hallId: ids.hall,
      serviceCategory: 'HOUSE_HELP',
      serviceSubtype: 'General',
      employeeCode: 'HELP-ROTATE-1',
    } as CreatePersonDto);
    createdUserIds.push(created.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(user.mustChangePassword).toBe(true);
    expect(user.approvalStatus).toBe('APPROVED');
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    const loginResult = await auth.login(
      { email: `${key}-rotate@example.test`, password, portal: 'OPERATIONS' },
      response as never,
    );
    expect(loginResult.mustChangePassword).toBe(true);
    const changed = await auth.changePassword(
      { userId: created.id, role: 'STAFF', eventIds: [ids.event], hallIds: [ids.hall], serviceTypes: ['HOUSE_HELP'] },
      { currentPassword: password, newPassword: `${password}New1` },
      { sessionId: undefined } as never,
    );
    expect(changed.mustChangePassword).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).mustChangePassword).toBe(false);
  }, 20000);

  it('prevents DISABLED staff from logging in', async () => {
    await workforce.updatePerson(managerScope, ids.staffUser, { status: 'DISABLED' });
    const response = {
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
    await expect(
      auth.login({ email: `${key}-staff@example.test`, password, portal: 'OPERATIONS' }, response as never),
    ).rejects.toThrow(/Invalid credentials|Unauthorized/i);
  });
});

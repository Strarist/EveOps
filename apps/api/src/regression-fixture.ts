import { hash } from 'bcryptjs';
import type { PrismaClient, Availability, ServicePriority } from '@prisma/client';
import type { AuthScope } from '@eveops/contracts';
import { TicketService } from './tickets';

/** Isolated database name. The fixture refuses every other database. */
export const REGRESSION_DATABASE_NAME = 'eveops_regression';

/**
 * Lab password for synthetic @volume.lab accounts.
 * Supply REGRESSION_FIXTURE_PASSWORD in the environment. Do not commit it or print it.
 */
export function regressionFixturePassword() {
  const value = process.env.REGRESSION_FIXTURE_PASSWORD ?? '';
  if (value.length < 12 || /\s/.test(value)) {
    throw new Error('Set REGRESSION_FIXTURE_PASSWORD in the environment to a single password of at least 12 characters. Do not commit it.');
  }
  return value;
}

const ORG_ID = 'regression-org';
const FOREIGN_ORG_ID = 'regression-org-foreign';
const EVENT_ID = 'regression-event';
const BOUNDARY_EVENT_ID = 'regression-event-boundary';
const OUTSIDE_EVENT_ID = 'regression-event-outside';
const FOREIGN_EVENT_ID = 'regression-event-foreign';

const HALL_STALL_COUNTS = [5, 5, 4, 4] as const;
const STALL_PRIORITIES: ServicePriority[] = [
  'HIGH', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW',
  'HIGH', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW',
  'HIGH', 'MEDIUM', 'LOW', 'LOW',
  'HIGH', 'MEDIUM', 'LOW', 'LOW',
];

type StaffKind = 'ELECTRICAL' | 'HOUSE_HELP';

type StaffPlan = {
  hall: number;
  kind: StaffKind;
  slot: 1 | 2;
  availability: Availability;
  busy?: boolean;
};

const STAFF_PLAN: StaffPlan[] = [
  { hall: 1, kind: 'ELECTRICAL', slot: 1, availability: 'ON_DUTY' },
  { hall: 1, kind: 'ELECTRICAL', slot: 2, availability: 'ON_DUTY', busy: true },
  { hall: 1, kind: 'HOUSE_HELP', slot: 1, availability: 'ON_DUTY' },
  { hall: 1, kind: 'HOUSE_HELP', slot: 2, availability: 'OFF_DUTY' },
  { hall: 2, kind: 'ELECTRICAL', slot: 1, availability: 'ON_DUTY' },
  { hall: 2, kind: 'ELECTRICAL', slot: 2, availability: 'OFF_DUTY' },
  { hall: 2, kind: 'HOUSE_HELP', slot: 1, availability: 'ON_DUTY', busy: true },
  { hall: 2, kind: 'HOUSE_HELP', slot: 2, availability: 'PAUSED' },
  { hall: 3, kind: 'ELECTRICAL', slot: 1, availability: 'OFF_DUTY' },
  { hall: 3, kind: 'ELECTRICAL', slot: 2, availability: 'ON_DUTY' },
  { hall: 3, kind: 'HOUSE_HELP', slot: 1, availability: 'ON_DUTY' },
  { hall: 3, kind: 'HOUSE_HELP', slot: 2, availability: 'OFF_DUTY' },
  { hall: 4, kind: 'ELECTRICAL', slot: 1, availability: 'ON_DUTY' },
  { hall: 4, kind: 'ELECTRICAL', slot: 2, availability: 'OFF_DUTY' },
  { hall: 4, kind: 'HOUSE_HELP', slot: 1, availability: 'OFF_DUTY' },
  { hall: 4, kind: 'HOUSE_HELP', slot: 2, availability: 'ON_DUTY' },
];

export type RegressionAccount = {
  id: string;
  email: string;
  role: AuthScope['role'];
  name: string;
};

export type RegressionStall = {
  id: string;
  code: string;
  hallCode: string;
  hallId: string;
  zoneId: string;
  servicePriority: ServicePriority;
  userId: string;
  email: string;
};

export type RegressionStaff = {
  id: string;
  email: string;
  name: string;
  hallCode: string;
  hallId: string;
  kind: StaffKind;
  slot: 1 | 2;
  availability: Availability;
  busy: boolean;
};

export type RegressionFixture = {
  organizationId: string;
  foreignOrganizationId: string;
  eventId: string;
  boundaryEventId: string;
  outsideEventId: string;
  foreignEventId: string;
  admin: RegressionAccount & { scope: AuthScope };
  superAdmin: RegressionAccount & { scope: AuthScope };
  managers: Array<RegressionAccount & { hallCode: string; hallId: string; scope: AuthScope }>;
  stalls: RegressionStall[];
  staff: RegressionStaff[];
  vacantStallId: string;
  busyTicketIds: string[];
  userCount: number;
  counts: {
    admin: number;
    superAdmin: number;
    managers: number;
    stalls: number;
    electricians: number;
    houseHelp: number;
  };
};

function hallCode(hall: number) {
  return `H${hall}`;
}

function databaseTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  return {
    name: url.pathname.replace(/^\//, '').split('?')[0],
    host: url.hostname,
  };
}

export function assertRegressionDatabase() {
  const { name, host } = databaseTarget();
  if (name !== REGRESSION_DATABASE_NAME) {
    throw new Error(`Refusing regression fixture work on database "${name}". Use ${REGRESSION_DATABASE_NAME}.`);
  }
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!localHost) {
    throw new Error(`Refusing regression fixture work on host "${host}". Use a localhost database named ${REGRESSION_DATABASE_NAME}.`);
  }
}

function scope(partial: AuthScope): AuthScope {
  return partial;
}

export async function ensureRegressionFixture(prisma: PrismaClient): Promise<RegressionFixture> {
  assertRegressionDatabase();
  const priorityCount = STALL_PRIORITIES.reduce<Record<ServicePriority, number>>(
    (counts, priority) => ({ ...counts, [priority]: counts[priority] + 1 }),
    { HIGH: 0, MEDIUM: 0, LOW: 0 },
  );
  if (priorityCount.HIGH !== 6 || priorityCount.MEDIUM !== 6 || priorityCount.LOW !== 6 || STALL_PRIORITIES.length !== 18) {
    throw new Error('Stall priority plan must be 6 HIGH, 6 MEDIUM, and 6 LOW across 18 stalls');
  }

  const passwordHash = await hash(regressionFixturePassword(), 12);
  const windowStart = new Date('2026-10-01T00:00:00Z');
  const windowEnd = new Date('2026-10-10T00:00:00Z');

  await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: { name: 'Volume Lab Exhibitions' },
    create: { id: ORG_ID, name: 'Volume Lab Exhibitions' },
  });
  await prisma.organization.upsert({
    where: { id: FOREIGN_ORG_ID },
    update: { name: 'Volume Lab Foreign Org' },
    create: { id: FOREIGN_ORG_ID, name: 'Volume Lab Foreign Org' },
  });

  for (const event of [
    { id: EVENT_ID, organizationId: ORG_ID, name: 'Volume Lab Expo', venue: 'Volume Hall' },
    { id: BOUNDARY_EVENT_ID, organizationId: ORG_ID, name: 'Volume Lab Boundary', venue: 'Boundary Hall' },
    { id: OUTSIDE_EVENT_ID, organizationId: ORG_ID, name: 'Volume Lab Unscoped', venue: 'Unscoped Hall' },
    { id: FOREIGN_EVENT_ID, organizationId: FOREIGN_ORG_ID, name: 'Volume Lab Foreign Event', venue: 'Foreign Hall' },
  ]) {
    await prisma.event.upsert({
      where: { id: event.id },
      update: { name: event.name, status: 'ACTIVE', timezone: 'Asia/Kolkata' },
      create: {
        id: event.id,
        organizationId: event.organizationId,
        name: event.name,
        venue: event.venue,
        timezone: 'Asia/Kolkata',
        startsAt: windowStart,
        endsAt: windowEnd,
        status: 'ACTIVE',
      },
    });
  }

  const halls: Array<{ id: string; code: string; zoneId: string }> = [];
  for (let index = 0; index < HALL_STALL_COUNTS.length; index += 1) {
    const code = hallCode(index + 1);
    const id = `regression-hall-${code.toLowerCase()}`;
    await prisma.hall.upsert({
      where: { id },
      update: { name: `Hall ${index + 1}`, active: true },
      create: { id, eventId: EVENT_ID, code, name: `Hall ${index + 1}`, active: true },
    });
    const zoneId = `regression-zone-${code.toLowerCase()}`;
    await prisma.zone.upsert({
      where: { id: zoneId },
      update: { active: true },
      create: { id: zoneId, eventId: EVENT_ID, hallId: id, code: 'A', active: true },
    });
    halls.push({ id, code, zoneId });
    for (const pool of [
      ['ELECTRICAL', 'Lighting'],
      ['ELECTRICAL', 'NCP'],
      ['HOUSE_HELP', 'General'],
      ['HALL_MANAGER', 'General'],
    ] as const) {
      await prisma.servicePool.upsert({
        where: {
          eventId_hallId_category_subtype: { eventId: EVENT_ID, hallId: id, category: pool[0], subtype: pool[1] },
        },
        update: { active: true },
        create: { id: `regression-pool-${code.toLowerCase()}-${pool[0].toLowerCase()}-${pool[1].toLowerCase()}`, eventId: EVENT_ID, hallId: id, category: pool[0], subtype: pool[1], active: true },
      });
    }
  }

  const boundaryHallId = 'regression-hall-boundary';
  await prisma.hall.upsert({
    where: { id: boundaryHallId },
    update: { active: true },
    create: { id: boundaryHallId, eventId: BOUNDARY_EVENT_ID, code: 'B1', name: 'Boundary Hall', active: true },
  });
  const boundaryZoneId = 'regression-zone-boundary';
  await prisma.zone.upsert({
    where: { id: boundaryZoneId },
    update: { active: true },
    create: { id: boundaryZoneId, eventId: BOUNDARY_EVENT_ID, hallId: boundaryHallId, code: 'A', active: true },
  });
  const boundaryStallId = 'regression-stall-boundary';
  await prisma.stall.upsert({
    where: { id: boundaryStallId },
    update: { active: true, archivedAt: null, servicePriority: 'MEDIUM' },
    create: {
      id: boundaryStallId,
      eventId: BOUNDARY_EVENT_ID,
      zoneId: boundaryZoneId,
      stallCode: 'B-01',
      exhibitorName: 'Boundary Exhibit',
      servicePriority: 'MEDIUM',
      active: true,
    },
  });
  await prisma.servicePool.upsert({
    where: { eventId_hallId_category_subtype: { eventId: BOUNDARY_EVENT_ID, hallId: boundaryHallId, category: 'ELECTRICAL', subtype: 'Lighting' } },
    update: { active: true },
    create: { id: 'regression-pool-boundary-lighting', eventId: BOUNDARY_EVENT_ID, hallId: boundaryHallId, category: 'ELECTRICAL', subtype: 'Lighting' },
  });

  for (const spare of [
    { eventId: OUTSIDE_EVENT_ID, hallId: 'regression-hall-outside', zoneId: 'regression-zone-outside', stallId: 'regression-stall-outside', code: 'U1' },
    { eventId: FOREIGN_EVENT_ID, hallId: 'regression-hall-foreign', zoneId: 'regression-zone-foreign', stallId: 'regression-stall-foreign', code: 'F1' },
  ]) {
    await prisma.hall.upsert({
      where: { id: spare.hallId },
      update: { active: true },
      create: { id: spare.hallId, eventId: spare.eventId, code: spare.code, name: spare.code, active: true },
    });
    await prisma.zone.upsert({
      where: { id: spare.zoneId },
      update: { active: true },
      create: { id: spare.zoneId, eventId: spare.eventId, hallId: spare.hallId, code: 'A', active: true },
    });
    await prisma.stall.upsert({
      where: { id: spare.stallId },
      update: { active: true },
      create: {
        id: spare.stallId,
        eventId: spare.eventId,
        zoneId: spare.zoneId,
        stallCode: 'S1',
        exhibitorName: 'Unscoped stall',
        servicePriority: 'LOW',
      },
    });
  }

  const stalls: RegressionStall[] = [];
  let priorityIndex = 0;
  for (let hallIndex = 0; hallIndex < halls.length; hallIndex += 1) {
    const hall = halls[hallIndex];
    for (let stallIndex = 0; stallIndex < HALL_STALL_COUNTS[hallIndex]; stallIndex += 1) {
      const number = String(stallIndex + 1).padStart(2, '0');
      const code = `${hall.code}-${number}`;
      const id = `regression-stall-${code.toLowerCase()}`;
      const userId = `regression-user-stall-${code.toLowerCase()}`;
      const email = `regression.stall.${code.toLowerCase()}@volume.lab`;
      const servicePriority = STALL_PRIORITIES[priorityIndex];
      priorityIndex += 1;
      await prisma.stall.upsert({
        where: { id },
        update: { stallCode: code, exhibitorName: `Exhibit ${code}`, servicePriority, active: true, archivedAt: null },
        create: {
          id,
          eventId: EVENT_ID,
          zoneId: hall.zoneId,
          stallCode: code,
          exhibitorName: `Exhibit ${code}`,
          contact: null,
          servicePriority,
          active: true,
        },
      });
      await upsertAccount(prisma, passwordHash, {
        id: userId,
        email,
        name: `Exhibitor ${code}`,
        role: 'STALL',
        employeeCode: `REG-ST-${code}`,
      });
      stalls.push({ id, code, hallCode: hall.code, hallId: hall.id, zoneId: hall.zoneId, servicePriority, userId, email });
    }
  }

  const vacantStallId = 'regression-stall-h4-vacant';
  await prisma.stall.upsert({
    where: { id: vacantStallId },
    update: { active: true, archivedAt: null, servicePriority: 'MEDIUM', exhibitorName: 'Vacant booth' },
    create: {
      id: vacantStallId,
      eventId: EVENT_ID,
      zoneId: halls[3].zoneId,
      stallCode: 'H4-VACANT',
      exhibitorName: 'Vacant booth',
      servicePriority: 'MEDIUM',
      active: true,
    },
  });

  const adminId = 'regression-user-admin';
  const adminEmail = 'regression.admin@volume.lab';
  await upsertAccount(prisma, passwordHash, {
    id: adminId,
    email: adminEmail,
    name: 'Volume Lab Admin',
    role: 'ADMIN',
    employeeCode: 'REG-ADM-01',
  });
  const superId = 'regression-user-super';
  const superEmail = 'regression.super@volume.lab';
  await upsertAccount(prisma, passwordHash, {
    id: superId,
    email: superEmail,
    name: 'Volume Lab Super Admin',
    role: 'SUPER_ADMIN',
    employeeCode: 'REG-SA-01',
  });

  const managers = [];
  for (const hall of halls) {
    const id = `regression-user-manager-${hall.code.toLowerCase()}`;
    const email = `regression.manager.${hall.code.toLowerCase()}@volume.lab`;
    await upsertAccount(prisma, passwordHash, {
      id,
      email,
      name: `Manager ${hall.code}`,
      role: 'HALL_MANAGER',
      employeeCode: `REG-HM-${hall.code}`,
    });
    managers.push({ id, email, role: 'HALL_MANAGER' as const, name: `Manager ${hall.code}`, hallCode: hall.code, hallId: hall.id });
  }

  const staff: RegressionStaff[] = [];
  for (const plan of STAFF_PLAN) {
    const code = hallCode(plan.hall);
    const hall = halls[plan.hall - 1];
    const kindKey = plan.kind === 'ELECTRICAL' ? 'elec' : 'help';
    const id = `regression-user-${kindKey}-${code.toLowerCase()}-${plan.slot}`;
    const email = `regression.${kindKey}.${code.toLowerCase()}.${plan.slot}@volume.lab`;
    const name = `${plan.kind === 'ELECTRICAL' ? 'Electrician' : 'House help'} ${code}.${plan.slot}`;
    await upsertAccount(prisma, passwordHash, {
      id,
      email,
      name,
      role: 'STAFF',
      employeeCode: `REG-${plan.kind === 'ELECTRICAL' ? 'EL' : 'HH'}-${code}-${plan.slot}`,
    });
    staff.push({
      id,
      email,
      name,
      hallCode: code,
      hallId: hall.id,
      kind: plan.kind,
      slot: plan.slot,
      availability: plan.availability,
      busy: Boolean(plan.busy),
    });
  }

  const fixtureUserIds = [
    adminId,
    superId,
    ...managers.map((manager) => manager.id),
    ...stalls.map((stall) => stall.userId),
    ...staff.map((person) => person.id),
  ];
  await prisma.userScope.deleteMany({ where: { userId: { in: fixtureUserIds } } });
  await prisma.userScope.createMany({
    data: [
      { userId: adminId, eventId: EVENT_ID },
      { userId: superId, eventId: EVENT_ID },
      { userId: superId, eventId: BOUNDARY_EVENT_ID },
      ...managers.map((manager) => ({ userId: manager.id, eventId: EVENT_ID, hallId: manager.hallId })),
      ...stalls.map((stall) => ({ userId: stall.userId, eventId: EVENT_ID, hallId: stall.hallId, stallId: stall.id })),
      ...staff.map((person) => ({ userId: person.id, eventId: EVENT_ID, hallId: person.hallId, serviceType: person.kind })),
    ],
  });

  await prisma.workforceMembership.deleteMany({ where: { userId: { in: [...managers.map((manager) => manager.id), ...staff.map((person) => person.id)] } } });
  for (const hall of halls) {
    const manager = managers.find((person) => person.hallId === hall.id);
    const managerPool = await prisma.servicePool.findUniqueOrThrow({
      where: { eventId_hallId_category_subtype: { eventId: EVENT_ID, hallId: hall.id, category: 'HALL_MANAGER', subtype: 'General' } },
    });
    await prisma.workforceMembership.create({
      data: { eventId: EVENT_ID, poolId: managerPool.id, userId: manager!.id, availability: 'ON_DUTY', capacity: 1 },
    });
    for (const person of staff.filter((member) => member.hallId === hall.id)) {
      const subtypes = person.kind === 'HOUSE_HELP'
        ? ['General']
        : person.slot === 1
          ? ['Lighting', 'NCP']
          : ['Lighting'];
      for (const subtype of subtypes) {
        const pool = await prisma.servicePool.findUniqueOrThrow({
          where: { eventId_hallId_category_subtype: { eventId: EVENT_ID, hallId: hall.id, category: person.kind, subtype } },
        });
        await prisma.workforceMembership.create({
          data: { eventId: EVENT_ID, poolId: pool.id, userId: person.id, availability: person.availability, capacity: 1 },
        });
      }
    }
  }

  const tickets = new TicketService(prisma as unknown as ConstructorParameters<typeof TicketService>[0]);
  const busyTicketIds: string[] = [];
  const electricalBusy = staff.find((person) => person.busy && person.kind === 'ELECTRICAL');
  const electricalPeer = staff.find((person) => person.hallId === electricalBusy?.hallId && person.kind === 'ELECTRICAL' && person.id !== electricalBusy?.id);
  const houseBusy = staff.find((person) => person.busy && person.kind === 'HOUSE_HELP');
  busyTicketIds.push(await ensureBusyTicket(prisma, tickets, {
    assignee: electricalBusy!,
    peer: electricalPeer,
    stall: stalls.find((stall) => stall.hallId === electricalBusy?.hallId)!,
    category: 'ELECTRICAL',
    subtype: 'Lighting',
    key: 'fixture-busy-h1-elec',
    description: 'Fixture busy electrical task for the volume lab',
  }));
  busyTicketIds.push(await ensureBusyTicket(prisma, tickets, {
    assignee: houseBusy!,
    stall: stalls.find((stall) => stall.hallId === houseBusy?.hallId)!,
    category: 'HOUSE_HELP',
    subtype: 'General',
    key: 'fixture-busy-h2-help',
    description: 'Fixture busy housekeeping task for the volume lab',
  }));

  const superScope = scope({
    userId: superId,
    role: 'SUPER_ADMIN',
    eventIds: [EVENT_ID, BOUNDARY_EVENT_ID],
    hallIds: [],
    serviceTypes: [],
  });
  const boundaryTicket = await prisma.ticket.findUnique({
    where: { createdById_idempotencyKey: { createdById: superId, idempotencyKey: 'fixture-boundary-sample' } },
  });
  if (!boundaryTicket) {
    await tickets.create({
      stallId: boundaryStallId,
      category: 'ELECTRICAL',
      subtype: 'Lighting',
      description: 'Boundary event sample with no assigned worker',
      priority: 'NORMAL',
      idempotencyKey: 'fixture-boundary-sample',
    }, superScope);
  }

  const userCount = await prisma.user.count({ where: { organizationId: ORG_ID } });
  if (userCount !== 40) {
    throw new Error(`Regression organization must contain exactly 40 users after seeding. Found ${userCount}.`);
  }

  return {
    organizationId: ORG_ID,
    foreignOrganizationId: FOREIGN_ORG_ID,
    eventId: EVENT_ID,
    boundaryEventId: BOUNDARY_EVENT_ID,
    outsideEventId: OUTSIDE_EVENT_ID,
    foreignEventId: FOREIGN_EVENT_ID,
    admin: {
      id: adminId,
      email: adminEmail,
      role: 'ADMIN',
      name: 'Volume Lab Admin',
      scope: scope({ userId: adminId, role: 'ADMIN', eventIds: [EVENT_ID], hallIds: [], serviceTypes: [] }),
    },
    superAdmin: {
      id: superId,
      email: superEmail,
      role: 'SUPER_ADMIN',
      name: 'Volume Lab Super Admin',
      scope: superScope,
    },
    managers: managers.map((manager) => ({
      ...manager,
      scope: scope({
        userId: manager.id,
        role: 'HALL_MANAGER',
        eventIds: [EVENT_ID],
        hallIds: [manager.hallId],
        serviceTypes: [],
      }),
    })),
    stalls,
    staff,
    vacantStallId,
    busyTicketIds,
    userCount,
    counts: {
      admin: 1,
      superAdmin: 1,
      managers: managers.length,
      stalls: stalls.length,
      electricians: staff.filter((person) => person.kind === 'ELECTRICAL').length,
      houseHelp: staff.filter((person) => person.kind === 'HOUSE_HELP').length,
    },
  };
}

async function upsertAccount(
  prisma: PrismaClient,
  passwordHash: string,
  account: { id: string; email: string; name: string; role: AuthScope['role']; employeeCode: string },
) {
  await prisma.user.upsert({
    where: { id: account.id },
    update: {
      email: account.email,
      name: account.name,
      role: account.role,
      employeeCode: account.employeeCode,
      passwordHash,
      status: 'ACTIVE',
      approvalStatus: 'APPROVED',
      mustChangePassword: false,
      organizationId: ORG_ID,
    },
    create: {
      id: account.id,
      organizationId: ORG_ID,
      email: account.email,
      name: account.name,
      role: account.role,
      employeeCode: account.employeeCode,
      passwordHash,
      status: 'ACTIVE',
      approvalStatus: 'APPROVED',
      mustChangePassword: false,
    },
  });
}

async function ensureBusyTicket(
  prisma: PrismaClient,
  tickets: TicketService,
  input: {
    assignee: RegressionStaff;
    peer?: RegressionStaff;
    stall: RegressionStall;
    category: 'ELECTRICAL' | 'HOUSE_HELP';
    subtype: string;
    key: string;
    description: string;
  },
) {
  const active = await prisma.assignment.findFirst({
    where: { staffId: input.assignee.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    select: { ticketId: true },
  });
  if (active) return active.ticketId;

  const stallScope = scope({
    userId: input.stall.userId,
    role: 'STALL',
    eventIds: [EVENT_ID],
    hallIds: [input.stall.hallId],
    stallId: input.stall.id,
    serviceTypes: [],
  });
  let key = input.key;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await prisma.ticket.findUnique({
      where: { createdById_idempotencyKey: { createdById: input.stall.userId, idempotencyKey: key } },
    });
    if (!existing) {
      if (input.peer) {
        await prisma.workforceMembership.updateMany({
          where: { userId: input.peer.id },
          data: { availability: 'OFF_DUTY' },
        });
      }
      try {
        await tickets.create({
          category: input.category,
          subtype: input.subtype,
          description: input.description,
          priority: 'NORMAL',
          idempotencyKey: key,
        }, stallScope);
      } finally {
        if (input.peer) {
          await prisma.workforceMembership.updateMany({
            where: { userId: input.peer.id },
            data: { availability: input.peer.availability },
          });
        }
      }
      break;
    }
    if (['NEW', 'QUEUED', 'REOPENED'].includes(existing.status)) {
      await tickets.route(existing.id);
      break;
    }
    if (['ASSIGNED', 'SNOOZED', 'ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP'].includes(existing.status)) break;
    key = `${input.key}-${attempt + 2}`;
  }
  const assignment = await prisma.assignment.findFirst({
    where: { staffId: input.assignee.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    select: { ticketId: true },
  });
  if (!assignment) throw new Error(`Busy example for ${input.assignee.email} was not assigned through routing`);
  return assignment.ticketId;
}

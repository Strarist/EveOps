import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();
async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Demo seed is disabled in production');
  }
  const passwordHash = await hash('EveOpsDemo!2026', 12);
  const organization = await prisma.organization.upsert({ where: { id: 'demo-org' }, update: {}, create: { id: 'demo-org', name: 'Nexus Exhibitions' } });
  const event = await prisma.event.upsert({ where: { id: 'demo-event' }, update: {}, create: { id: 'demo-event', organizationId: organization.id, name: 'Auto Expo 2026', venue: 'Pragati Maidan', startsAt: new Date('2026-09-08'), endsAt: new Date('2026-09-12'), status: 'ACTIVE' } });
  const hall = await prisma.hall.upsert({ where: { eventId_code: { eventId: event.id, code: 'H2' } }, update: {}, create: { eventId: event.id, code: 'H2', name: 'Hall 2' } });
  const zone = await prisma.zone.upsert({ where: { hallId_code: { hallId: hall.id, code: 'B' } }, update: { eventId: event.id }, create: { eventId: event.id, hallId: hall.id, code: 'B' } });
  const stall = await prisma.stall.upsert({ where: { zoneId_stallCode: { zoneId: zone.id, stallCode: 'B203' } }, update: { eventId: event.id }, create: { eventId: event.id, zoneId: zone.id, stallCode: 'B203', exhibitorName: 'Velocity Motors', contact: '+91-0000000000' } });
  // Person age is not an MVP operational field (ticket age is separate and server-derived).
  const users = [
    ['stall@eveops.test', 'Stall B203', 'STALL', null, 'STALL-B203'],
    ['staff@eveops.test', 'Rahul Kumar', 'STAFF', 'ELECTRICAL', 'STF-ELEC-01'],
    ['house.staff@eveops.test', 'Meena Singh', 'STAFF', 'HOUSE_HELP', 'STF-HOUSE-01'],
    ['manager@eveops.test', 'Priya Mehra', 'HALL_MANAGER', null, 'HM-H2-01'],
    ['admin@eveops.test', 'Aditi Mehra', 'ADMIN', null, 'ADM-EVENT-01'],
    ['super@eveops.test', 'Super Admin', 'SUPER_ADMIN', null, 'SA-ORG-01'],
  ] as const;
  for (const [email, name, role, serviceType, employeeCode] of users) {
    const user = await prisma.user.upsert({
      where: { email },
      update: { organizationId: organization.id, name, role, status: 'ACTIVE', passwordHash, employeeCode },
      create: { organizationId: organization.id, email, name, role, passwordHash, employeeCode },
    });
    await prisma.userScope.deleteMany({ where: { userId: user.id } });
    await prisma.userScope.create({ data: { userId: user.id, eventId: event.id, hallId: ['STALL', 'HALL_MANAGER', 'STAFF'].includes(role) ? hall.id : null, stallId: role === 'STALL' ? stall.id : null, serviceType } });
  }
  const poolDefinitions = [
    ['ELECTRICAL', 'Lighting', 'staff@eveops.test'],
    ['ELECTRICAL', 'NCP', 'staff@eveops.test'],
    ['HOUSE_HELP', 'General', 'house.staff@eveops.test'],
    ['HALL_MANAGER', 'General', 'manager@eveops.test'],
  ] as const;
  for (const [category, subtype, email] of poolDefinitions) {
    const pool = await prisma.servicePool.upsert({
      where: { eventId_hallId_category_subtype: { eventId: event.id, hallId: hall.id, category, subtype } },
      update: {},
      create: { eventId: event.id, hallId: hall.id, category, subtype },
    });
    const staff = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.workforceMembership.upsert({
      where: { poolId_userId: { poolId: pool.id, userId: staff.id } },
      update: { eventId: event.id, availability: 'ON_DUTY' },
      create: { eventId: event.id, poolId: pool.id, userId: staff.id, availability: 'ON_DUTY' },
    });
  }
}
main().finally(() => prisma.$disconnect());

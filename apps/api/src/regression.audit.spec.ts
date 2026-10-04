import type { AuthScope } from '@eveops/contracts';
import { ManagementService } from './management';
import { PrismaService } from './prisma.service';
import { assertRegressionDatabase, ensureRegressionFixture } from './regression-fixture';

const isolated = (() => {
  try {
    assertRegressionDatabase();
    return true;
  } catch {
    return false;
  }
})();

(isolated ? describe : describe.skip)('administrative audit pages', () => {
  const prisma = new PrismaService();
  const management = new ManagementService(prisma);
  const admin: AuthScope = {
    userId: 'regression-user-admin',
    role: 'ADMIN',
    eventIds: ['regression-event'],
    hallIds: [],
    serviceTypes: [],
  };

  beforeAll(async () => {
    await ensureRegressionFixture(prisma);
    await prisma.ticketEvent.deleteMany({ where: { id: { startsWith: 'auditpage-event-' } } });
    await prisma.managementAudit.deleteMany({ where: { id: { startsWith: 'auditpage-audit-' } } });
    await prisma.ticket.deleteMany({ where: { id: 'auditpage-ticket' } });
    const stall = await prisma.stall.findFirstOrThrow({
      where: { eventId: 'regression-event', stallCode: 'H1-01' },
      include: { zone: true },
    });
    const owner = await prisma.userScope.findFirstOrThrow({ where: { stallId: stall.id, user: { role: 'STALL' } } });
    await prisma.ticket.create({
      data: {
        id: 'auditpage-ticket',
        publicNo: 'AUDITPAGE-1',
        eventId: 'regression-event',
        hallId: stall.zone.hallId,
        zoneId: stall.zoneId,
        stallId: stall.id,
        category: 'ELECTRICAL',
        subtype: 'Lighting',
        description: 'Audit page fixture',
        servicePriority: 'HIGH',
        status: 'CLOSED',
        createdById: owner.userId,
        idempotencyKey: 'auditpage-ticket',
        closedAt: new Date('2026-03-01T00:00:00.000Z'),
      },
    });
    await prisma.ticketEvent.createMany({
      data: Array.from({ length: 90 }, (_, index) => ({
        id: `auditpage-event-${index}`,
        eventId: 'regression-event',
        ticketId: 'auditpage-ticket',
        eventType: 'AUDITPAGE_NOTE',
        actorId: owner.userId,
        correlationId: `auditpage-${index}`,
        createdAt: new Date(Date.UTC(2026, 2, 1, 0, index)),
      })),
    });
    await prisma.managementAudit.createMany({
      data: Array.from({ length: 40 }, (_, index) => ({
        id: `auditpage-audit-${index}`,
        organizationId: 'regression-org',
        eventId: 'regression-event',
        actorId: admin.userId,
        targetUserId: owner.userId,
        action: 'AUDITPAGE_NOTE',
        createdAt: new Date(Date.UTC(2026, 2, 2, 0, index)),
      })),
    });
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { id: { startsWith: 'auditpage-event-' } } });
    await prisma.managementAudit.deleteMany({ where: { id: { startsWith: 'auditpage-audit-' } } });
    await prisma.ticket.deleteMany({ where: { id: 'auditpage-ticket' } });
    await prisma.$disconnect();
  });

  it('walks a static filtered history without missing or duplicate rows', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await management.audit(admin, { action: 'AUDITPAGE_NOTE', cursor, limit: 25 });
      pages += 1;
      expect(page.items.length).toBeLessThanOrEqual(25);
      for (const item of page.items) {
        expect(item.eventType).toContain('AUDITPAGE_NOTE');
        const key = `${item.kind}:${item.id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(130);
  });

  it('shows a new row on refresh and leaves an older cursor in place', async () => {
    const first = await management.audit(admin, { action: 'AUDITPAGE_NOTE', limit: 20 });
    const cursor = first.nextCursor;
    expect(cursor).toBeTruthy();
    await prisma.managementAudit.create({
      data: {
        id: 'auditpage-audit-new',
        organizationId: 'regression-org',
        eventId: 'regression-event',
        actorId: admin.userId,
        action: 'AUDITPAGE_NOTE',
        createdAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    });
    const older = await management.audit(admin, { action: 'AUDITPAGE_NOTE', cursor: cursor!, limit: 20 });
    const refreshed = await management.audit(admin, { action: 'AUDITPAGE_NOTE', limit: 20 });
    expect(older.items.map((item) => item.id)).not.toContain('auditpage-audit-new');
    expect(refreshed.items[0]?.id).toBe('auditpage-audit-new');
    const overlap = new Set(first.items.map((item) => item.id));
    expect(older.items.some((item) => overlap.has(item.id))).toBe(false);
    await prisma.managementAudit.delete({ where: { id: 'auditpage-audit-new' } });
  });

  it('keeps hall managers inside their hall and rejects an oversized page', async () => {
    const manager = await ensureRegressionFixture(prisma);
    const hall4 = manager.managers.find((person) => person.hallCode === 'H4');
    const hidden = await management.audit(hall4!.scope, { ticket: 'AUDITPAGE-1', limit: 50 });
    expect(hidden.items).toEqual([]);
    const visible = await management.audit(manager.managers[0].scope, { ticket: 'AUDITPAGE-1', limit: 50 });
    expect(visible.items.length).toBeGreaterThan(0);
    expect(visible.items.every((item) => item.kind === 'ticket')).toBe(true);
    await expect(management.audit(admin, { limit: 101 })).rejects.toThrow(/1 to 100/);
    await expect(management.audit(admin, { cursor: '%%%' })).rejects.toThrow(/cursor/);
  });
});

if (!isolated) {
  console.warn('Skipping administrative audit pages because DATABASE_URL is not a localhost eveops_regression database.');
}

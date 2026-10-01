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

(isolated ? describe : describe.skip)('regression fixture seed', () => {
  const prisma = new PrismaService();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('upserts the 40 synthetic accounts without printing credentials', async () => {
    await prisma.$connect();
    const fixture = await ensureRegressionFixture(prisma);
    expect(fixture.userCount).toBe(40);
    expect(fixture.counts).toEqual({
      admin: 1,
      superAdmin: 1,
      managers: 4,
      stalls: 18,
      electricians: 8,
      houseHelp: 8,
    });
    expect(fixture.stalls.filter((stall) => stall.servicePriority === 'HIGH')).toHaveLength(6);
    expect(fixture.stalls.filter((stall) => stall.servicePriority === 'MEDIUM')).toHaveLength(6);
    expect(fixture.stalls.filter((stall) => stall.servicePriority === 'LOW')).toHaveLength(6);
    process.stdout.write(`Regression fixture ready: ${fixture.userCount} users, ${fixture.busyTicketIds.length} busy examples.\n`);
  });
});

import { expect, test, type Browser } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const apiOrigin = process.env.API_URL?.replace(/\/api$/, '') ?? 'http://localhost:4100';
const webOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:3110';
const prisma = new PrismaClient();
const sessionHashes: string[] = [];
const widths = [360, 390, 768, 1024, 1440];

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test.beforeAll(async () => {
  const health = await fetch(`${apiOrigin}/api/system/health`);
  const body = await health.json() as { databaseName?: string };
  if (body.databaseName !== 'eveops_regression') throw new Error('Super Admin checks require the isolated eveops_regression database.');
  expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);
  expect(await prisma.user.count({ where: { role: 'SUPER_ADMIN' } })).toBe(1);
  await cleanupSeed();
  const stall = await prisma.user.findUniqueOrThrow({
    where: { email: 'regression.stall.h1-01@volume.lab' },
    include: { scopes: true },
  });
  const scope = stall.scopes.find((item) => item.stallId && item.hallId);
  if (!scope?.stallId || !scope.hallId) throw new Error('Stall scope missing');
  const stallRow = await prisma.stall.findUniqueOrThrow({ where: { id: scope.stallId } });
  const pool = await prisma.servicePool.findFirstOrThrow({ where: { hallId: scope.hallId, category: 'HOUSE_HELP', subtype: 'General' } });
  const now = Date.now();
  await prisma.ticket.createMany({
    data: Array.from({ length: 55 }, (_, index) => ({
      publicNo: `P3D-${String(index).padStart(4, '0')}`,
      eventId: stallRow.eventId,
      hallId: scope.hallId!,
      zoneId: stallRow.zoneId,
      stallId: stallRow.id,
      poolId: pool.id,
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: 'Super Admin pagination sample',
      priority: 'NORMAL' as const,
      servicePriority: 'MEDIUM' as const,
      status: 'QUEUED' as const,
      createdById: stall.id,
      idempotencyKey: `phase3d-page-${index}`,
      createdAt: new Date(now - index * 1000),
    })),
  });
});

test.afterAll(async () => {
  await cleanupSeed();
  if (sessionHashes.length) await prisma.session.deleteMany({ where: { tokenHash: { in: sessionHashes } } });
  await prisma.$disconnect();
});

test('super admin stays inside authorized events and opens ticket activity', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await openSession(browser, 'regression.super@volume.lab', 1440);
  await page.goto('/super-admin');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.locator('.eyebrow').first()).toContainText('Volume Lab Exhibitions');
  await expect(page.locator('.metric strong').first()).not.toHaveText('—');
  const eventSelect = page.getByLabel('Event');
  await expect(eventSelect.locator('option', { hasText: 'Volume Lab Expo' })).toHaveCount(1);
  await expect(eventSelect.locator('option', { hasText: 'Volume Lab Boundary' })).toHaveCount(1);
  await expect(eventSelect.locator('option', { hasText: 'Volume Lab Foreign Event' })).toHaveCount(0);
  await expect(eventSelect.locator('option', { hasText: 'Volume Lab Unscoped' })).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Super Admin navigation' }).getByRole('button', { name: 'Events' }).click();
  await expect(page).toHaveURL(/section=Events/);
  await expect(page.getByRole('heading', { name: 'Authorized events' })).toBeVisible();
  await page.locator('article').filter({ hasText: 'Volume Lab Expo' }).getByRole('button', { name: 'Open tickets' }).click();
  await expect(page).toHaveURL(/section=Tickets/);
  await expect(page).toHaveURL(/event=/);
  const expo = await prisma.event.findFirstOrThrow({ where: { name: 'Volume Lab Expo' } });
  const listed = await page.request.get('/api/tickets?view=all&limit=50&eventId=' + encodeURIComponent(expo.id));
  expect(listed.ok()).toBeTruthy();
  const body = await listed.json() as { total: number; items: Array<{ publicNo: string }> };
  expect(body.total).toBeGreaterThan(50);
  await expect(page.locator('.operations .section-title p')).toContainText(`${body.total} authorized tickets`);
  await expect(page.locator('.operations .section-title p')).toContainText('Showing 50');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(async () => page.locator('.operations .section-title p').innerText()).toContain(`Showing ${Math.min(body.total, 100)}`);
  await page.getByRole('button', { name: /P3D-/ }).first().click();
  const drawer = page.getByRole('complementary', { name: /detail/ });
  await expect(drawer.getByRole('heading', { name: 'Activity', level: 3 })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Back to the list' }).click();
  await expect(page).not.toHaveURL(/ticket=/);
  await page.goBack();
  await expect(page).toHaveURL(/ticket=/);

  const boundary = await prisma.event.findFirstOrThrow({ where: { name: 'Volume Lab Boundary' } });
  await eventSelect.selectOption({ label: 'Volume Lab Boundary' });
  await expect(page).toHaveURL(new RegExp('event=' + boundary.id));
  await expect(page.getByText('P3D-0000')).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Super Admin navigation' }).getByRole('button', { name: 'Admins' }).click();
  await page.getByRole('button', { name: 'Add admin' }).click();
  await expect(page.getByRole('checkbox', { name: 'Volume Lab Expo' })).toBeVisible();
  await expect(page.locator('input[name="eventIds"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(1);

  await page.getByRole('navigation', { name: 'Super Admin navigation' }).getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByText('a dash means there is no completed sample or the figure has not loaded')).toBeVisible();
  await page.getByRole('navigation', { name: 'Super Admin navigation' }).getByRole('button', { name: 'Configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Service configuration' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Super Admin navigation' }).getByRole('button', { name: 'Audit' }).click();
  await expect(page.getByRole('heading', { name: 'Administrative history' })).toBeVisible();

  const admin = await openSession(browser, 'regression.admin@volume.lab', 1280);
  await admin.goto('/super-admin');
  await expect(admin).toHaveURL(/\/admin/);

  await mkdir('test-results/phase3d-super', { recursive: true });
  const shots: Array<[string, string]> = [
    ['/super-admin?section=Overview', 'overview'],
    ['/super-admin?section=Events', 'events'],
    ['/super-admin?section=Tickets', 'tickets'],
    ['/super-admin?section=Admins', 'admins'],
    ['/super-admin?section=Reports', 'reports'],
    ['/super-admin?section=Configuration', 'configuration'],
    ['/super-admin?section=Audit', 'audit'],
  ];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of shots) {
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeVisible();
      await expect(page.locator('.eyebrow').first()).toContainText('Volume Lab Exhibitions');
      if (name === 'overview') await expect(page.locator('.metric strong').first()).not.toHaveText('—');
      if (name === 'tickets') await expect(page.locator('.operations .section-title p')).toContainText(/Showing [1-9]/);
      if (name === 'reports') await expect(page.getByText('Hall figures have not loaded.')).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${name} at ${width}px`).toBeLessThanOrEqual(8);
      await page.screenshot({ path: `test-results/phase3d-super/${name}-${width}.png` });
    }
    await page.goto('/super-admin?section=Admins');
    await expect(page.getByLabel('Event').locator('option', { hasText: 'Volume Lab Expo' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Add admin' }).click();
    await expect(page.getByRole('checkbox', { name: 'Volume Lab Expo' })).toBeVisible();
    const formOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(formOverflow, `add admin at ${width}px`).toBeLessThanOrEqual(8);
    await page.screenshot({ path: `test-results/phase3d-super/add-admin-${width}.png` });
    await page.getByRole('button', { name: 'Cancel' }).click();
  }

  await page.context().close();
  await admin.context().close();
});

async function openSession(browser: Browser, email: string, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const token = await sessionToken(email);
  await context.addCookies([{ name: 'eveops_session', value: token, url: webOrigin }]);
  return page;
}

async function sessionToken(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  sessionHashes.push(tokenHash);
  await prisma.session.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  return token;
}

async function cleanupSeed() {
  const created = await prisma.ticket.findMany({
    where: { idempotencyKey: { startsWith: 'phase3d-' } },
    select: { id: true },
  });
  const ids = created.map((ticket) => ticket.id);
  if (!ids.length) return;
  await prisma.notification.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.assignment.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.otpChallenge.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.complaint.deleteMany({ where: { ticketId: { in: ids } } });
  await prisma.ticket.deleteMany({ where: { id: { in: ids } } });
}

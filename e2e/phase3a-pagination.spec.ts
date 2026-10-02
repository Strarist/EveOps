import { expect, test, type Browser } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const apiOrigin = process.env.API_URL?.replace(/\/api$/, '') ?? 'http://localhost:4100';
const webOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:3110';
const prisma = new PrismaClient();

test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const health = await fetch(`${apiOrigin}/api/system/health`);
  const body = await health.json() as { databaseName?: string };
  if (body.databaseName !== 'eveops_regression') {
    throw new Error('Pagination checks require the isolated eveops_regression database.');
  }
});

test.afterAll(async () => {
  const created = await prisma.ticket.findMany({
    where: { idempotencyKey: { startsWith: 'phase3a-page-' } },
    select: { id: true },
  });
  const ids = created.map((ticket) => ticket.id);
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.assignment.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.otpChallenge.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.complaint.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.ticket.deleteMany({ where: { id: { in: ids } } });
  }
  const staff = await prisma.user.findMany({
    where: { email: { in: ['regression.elec.h1.1@volume.lab', 'regression.elec.h1.2@volume.lab', 'regression.help.h1.1@volume.lab', 'regression.help.h1.2@volume.lab'] } },
    select: { id: true, email: true },
  });
  for (const person of staff) {
    const availability = person.email.endsWith('.2@volume.lab') && person.email.includes('elec') ? 'ON_DUTY' : person.email.includes('help.h1.2') ? 'OFF_DUTY' : 'ON_DUTY';
    await prisma.workforceMembership.updateMany({ where: { userId: person.id }, data: { availability } });
  }
  await prisma.$disconnect();
});

test('attention and queue pages stay truthful when the hall has more than one page', async ({ browser }) => {
  test.setTimeout(180_000);
  const stall = await prisma.user.findUniqueOrThrow({
    where: { email: 'regression.stall.h1-01@volume.lab' },
    include: { scopes: true },
  });
  const scope = stall.scopes.find((item) => item.stallId);
  if (!scope?.stallId || !scope.hallId) throw new Error('Stall scope missing');
  const stallRow = await prisma.stall.findUniqueOrThrow({ where: { id: scope.stallId } });
  const helpPool = await prisma.servicePool.findFirstOrThrow({ where: { hallId: scope.hallId, category: 'HOUSE_HELP', subtype: 'General' } });
  const electricalPool = await prisma.servicePool.findFirstOrThrow({ where: { hallId: scope.hallId, category: 'ELECTRICAL', subtype: 'Lighting' } });
  await prisma.workforceMembership.updateMany({
    where: { user: { email: { in: ['regression.elec.h1.1@volume.lab', 'regression.elec.h1.2@volume.lab', 'regression.help.h1.1@volume.lab', 'regression.help.h1.2@volume.lab'] } } },
    data: { availability: 'OFF_DUTY' },
  });
  const now = Date.now();
  await prisma.ticket.createMany({
    data: [
      ...Array.from({ length: 105 }, (_, index) => ({
        publicNo: `P3A-H-${String(index).padStart(4, '0')}`,
        eventId: stallRow.eventId,
        hallId: scope.hallId!,
        zoneId: stallRow.zoneId,
        stallId: stallRow.id,
        poolId: helpPool.id,
        category: 'HOUSE_HELP',
        subtype: 'General',
        description: 'Ordinary active work for pagination',
        priority: 'NORMAL' as const,
        servicePriority: 'MEDIUM' as const,
        status: 'IN_PROGRESS' as const,
        createdById: stall.id,
        idempotencyKey: `phase3a-page-h-${index}`,
        createdAt: new Date(now - (130 - index) * 1000),
      })),
      ...Array.from({ length: 55 }, (_, index) => ({
        publicNo: `P3A-N-${String(index).padStart(4, '0')}`,
        eventId: stallRow.eventId,
        hallId: scope.hallId!,
        zoneId: stallRow.zoneId,
        stallId: stallRow.id,
        poolId: helpPool.id,
        category: 'HOUSE_HELP',
        subtype: 'General',
        description: 'Attention-worthy work beyond the first page',
        priority: 'NORMAL' as const,
        servicePriority: 'MEDIUM' as const,
        status: 'NEW' as const,
        createdById: stall.id,
        idempotencyKey: `phase3a-page-n-${index}`,
        createdAt: new Date(now - (90 - index) * 1000),
      })),
      ...Array.from({ length: 55 }, (_, index) => ({
        publicNo: `P3A-Q-${String(index).padStart(4, '0')}`,
        eventId: stallRow.eventId,
        hallId: scope.hallId!,
        zoneId: stallRow.zoneId,
        stallId: stallRow.id,
        poolId: electricalPool.id,
        category: 'ELECTRICAL',
        subtype: 'Lighting',
        description: 'Queued electrical pagination',
        priority: 'NORMAL' as const,
        servicePriority: 'MEDIUM' as const,
        status: 'QUEUED' as const,
        createdById: stall.id,
        idempotencyKey: `phase3a-page-q-${index}`,
        createdAt: new Date(now - (70 - index) * 1000),
      })),
    ],
  });
  await prisma.ticket.create({
    data: {
      publicNo: 'P3A-MARK',
      eventId: stallRow.eventId,
      hallId: scope.hallId!,
      zoneId: stallRow.zoneId,
      stallId: stallRow.id,
      poolId: helpPool.id,
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: 'Attention marker beyond the first active page',
      priority: 'NORMAL',
      servicePriority: 'MEDIUM',
      status: 'COMPLAINT_RAISED',
      createdById: stall.id,
      idempotencyKey: 'phase3a-page-mark',
      createdAt: new Date(now),
    },
  });

  const manager = await openSession(browser, 'regression.manager.h1@volume.lab', 1280);
  const attentionRequests: string[] = [];
  manager.on('request', (request) => {
    if (request.url().includes('/api/tickets?') && request.url().includes('view=attention')) attentionRequests.push(request.url());
  });
  await manager.goto('/hall-manager');
  await expect(manager.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(manager.getByText('Nothing needs attention right now.')).toHaveCount(0);
  const attention = manager.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByText(/Showing [1-9]/)).toBeVisible();
  const shownBefore = Number((await attention.getByText(/Showing \d+/).innerText()).match(/Showing (\d+)/)?.[1] ?? 0);
  const badge = manager.getByRole('navigation', { name: 'Hall Manager navigation' }).getByRole('button', { name: /Attention/ });
  const badgeCount = Number((await badge.innerText()).match(/\d+/)?.[0] ?? 0);
  expect(badgeCount).toBeGreaterThan(shownBefore);
  expect(await attention.getByText('P3A-MARK').count()).toBe(0);
  for (let attempt = 0; attempt < 12 && await attention.getByText('P3A-MARK').count() === 0; attempt += 1) {
    const more = attention.getByRole('button', { name: 'Load more' });
    await more.waitFor({ state: 'attached' });
    await more.evaluate((element) => (element as HTMLButtonElement).click());
  }
  await expect(attention.getByText('P3A-MARK')).toBeVisible();
  expect(attentionRequests.some((url) => /limit=1000|limit=200/.test(url))).toBe(false);
  expect(attentionRequests.some((url) => url.includes('view=attention'))).toBe(true);
  expect(attentionRequests.some((url) => url.includes('view=active'))).toBe(false);
  await expect(badge).toContainText(String(badgeCount));

  await manager.getByRole('navigation', { name: 'Hall Manager navigation' }).getByRole('button', { name: 'Queue' }).click();
  await expect(manager.getByRole('heading', { name: 'Waiting queue' })).toBeVisible();
  await expect(manager.getByText(/^Scheduling position \d+/)).toHaveCount(0);
  const loadMore = manager.getByRole('button', { name: 'Load more' });
  await expect(loadMore).toBeVisible();
  const showing = manager.getByText(/Showing \d+/);
  const before = Number((await showing.innerText()).match(/Showing (\d+)/)?.[1] ?? 0);
  await loadMore.click();
  await expect.poll(async () => Number((await showing.innerText()).match(/Showing (\d+)/)?.[1] ?? 0)).toBeGreaterThan(before);
  await manager.locator('.manager-card').first().click();
  const openTicket = await manager.locator('.drawer .eyebrow').innerText();
  const loaded = Number((await showing.innerText()).match(/Showing (\d+)/)?.[1] ?? 0);
  const queuedRefresh = manager.waitForRequest((request) => request.method() === 'GET' && request.url().includes('view=queued'));
  const stallToken = await sessionToken('regression.stall.h1-01@volume.lab');
  const raised = await fetch(`${apiOrigin}/api/tickets`, {
    method: 'POST',
    headers: { cookie: `eveops_session=${stallToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'ELECTRICAL',
      subtype: 'Lighting',
      description: 'Realtime queue addition',
      priority: 'NORMAL',
      idempotencyKey: 'phase3a-page-live',
    }),
  });
  expect(raised.status).toBe(201);
  await queuedRefresh;
  await expect(manager.locator('.drawer .eyebrow')).toHaveText(openTicket);
  await expect.poll(async () => Number((await showing.innerText()).match(/Showing (\d+)/)?.[1] ?? 0)).toBeGreaterThanOrEqual(loaded);
  await manager.getByLabel('Queue service').selectOption('ELECTRICAL');
  await expect(manager.getByText('Scheduling position 1', { exact: true })).toBeVisible();
  await expect(manager.locator('.drawer .eyebrow')).toHaveText(openTicket);
  await manager.getByLabel('Queue service').selectOption('');
  await expect(manager.getByText(/^Scheduling position \d+/)).toHaveCount(0);
  await expect(manager.locator('.drawer .eyebrow')).toHaveText(openTicket);

  await manager.getByRole('navigation', { name: 'Hall Manager navigation' }).getByRole('button', { name: 'Tickets' }).click();
  await manager.getByLabel('Search tickets').fill('P3A-DOES-NOT-EXIST');
  await expect(manager.getByText('No tickets match these filters.')).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Clear filters' })).toHaveCount(1);

  await mkdir('test-results/phase3a-pagination', { recursive: true });
  await manager.screenshot({ path: 'test-results/phase3a-pagination/tickets-empty-search.png' });
  await manager.context().close();
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
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

import { expect, test, type Browser } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const apiOrigin = process.env.API_URL?.replace(/\/api$/, '') ?? 'http://localhost:4100';
const webOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:3110';
const prisma = new PrismaClient();
const widths = [360, 390, 768, 1024, 1440];

test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const health = await fetch(`${apiOrigin}/api/system/health`);
  const body = await health.json() as { databaseName?: string };
  if (body.databaseName !== 'eveops_regression') {
    throw new Error('Hall Manager browser checks require the isolated eveops_regression database.');
  }
});

test.afterAll(async () => {
  const created = await prisma.ticket.findMany({
    where: { idempotencyKey: { startsWith: 'phase3a-' } },
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
  await prisma.workforceMembership.updateMany({
    where: { user: { email: { in: ['regression.elec.h1.1@volume.lab', 'regression.elec.h1.2@volume.lab'] } } },
    data: { availability: 'ON_DUTY' },
  });
  await prisma.$disconnect();
});

test('hall manager attention, queue, detail, and staff journeys stay in scope', async ({ browser }) => {
  test.setTimeout(180_000);
  await prisma.workforceMembership.updateMany({
    where: { user: { email: { in: ['regression.elec.h1.1@volume.lab', 'regression.elec.h1.2@volume.lab'] } } },
    data: { availability: 'OFF_DUTY' },
  });
  const stamp = Date.now().toString(36);
  const olderLow = await raiseTicket(`phase3a-low-${stamp}`, 'regression.stall.h1-05@volume.lab', 'ELECTRICAL', 'Lighting', 'URGENT');
  const newerHigh = await raiseTicket(`phase3a-high-${stamp}`, 'regression.stall.h1-01@volume.lab', 'ELECTRICAL', 'Lighting', 'NORMAL');
  const foreign = await raiseTicket(`phase3a-h2-${stamp}`, 'regression.stall.h2-01@volume.lab', 'HOUSE_HELP', 'General', 'NORMAL');
  for (const ticket of [olderLow, newerHigh]) {
    await prisma.assignment.updateMany({
      where: { ticketId: ticket.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
      data: { status: 'RELEASED', activeTicketKey: null, releasedAt: new Date(), releaseReason: 'Phase 3A queue check' },
    });
  }
  await prisma.ticket.update({
    where: { id: olderLow.id },
    data: { servicePriority: 'LOW', priority: 'URGENT', status: 'QUEUED', createdAt: new Date('2026-10-01T01:00:00Z') },
  });
  await prisma.ticket.update({
    where: { id: newerHigh.id },
    data: { servicePriority: 'HIGH', priority: 'NORMAL', status: 'QUEUED', createdAt: new Date('2026-10-01T02:00:00Z') },
  });

  const manager = await openManager(browser, 'regression.manager.h1@volume.lab', 390);
  await expect(manager.getByRole('heading', { name: 'Hall 1 operations' })).toBeVisible();
  const nav = manager.getByRole('navigation', { name: 'Hall Manager navigation' });
  await expect(nav).toBeVisible();
  for (const label of ['Attention', 'Tickets', 'Queue', 'Staff']) {
    await expect(nav.getByRole('button', { name: label })).toBeVisible();
  }
  await expect(manager.getByRole('link', { name: 'Registrations' })).toHaveCount(0);
  await expect(manager.getByText('Open now')).toHaveCount(0);
  await expect(manager.getByRole('button', { name: 'Enable work alerts and continue' })).toBeVisible();
  await expect(manager.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(manager.getByText('Waiting tickets stay in Queue.')).toBeVisible();

  await nav.getByRole('button', { name: 'Queue' }).click();
  await expect(manager.getByRole('heading', { name: 'Waiting queue' })).toBeVisible();
  await expect(manager.getByText('Urgency does not change this order.')).toBeVisible();
  const queueText = await manager.locator('.manager-list').innerText();
  const highAt = queueText.indexOf('H1-01');
  const lowAt = queueText.indexOf('H1-05');
  expect(highAt).toBeGreaterThanOrEqual(0);
  expect(lowAt).toBeGreaterThan(highAt);
  await expect(manager.getByText(foreign.publicNo)).toHaveCount(0);

  await manager.getByRole('button', { name: /H1-05/ }).click();
  await expect(manager.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(manager.getByText('Stall priority LOW')).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Move ahead in the queue' })).toBeVisible();
  await manager.getByRole('button', { name: 'Back to the list' }).click();
  await expect(manager.getByRole('heading', { name: 'Waiting queue' })).toBeVisible();

  await nav.getByRole('button', { name: 'Tickets' }).click();
  await manager.getByLabel('Search tickets').fill(foreign.publicNo);
  await expect(manager.getByText('No tickets match these filters.')).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Clear filters' })).toHaveCount(1);
  await manager.getByRole('button', { name: 'Clear filters' }).click();

  await nav.getByRole('button', { name: 'Staff' }).click();
  await expect(manager.getByText('Stall registration and exhibitor logins stay with Admin.')).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Add Staff' })).toBeVisible();

  const other = await openManager(browser, 'regression.manager.h2@volume.lab', 390);
  await other.getByRole('navigation', { name: 'Hall Manager navigation' }).getByRole('button', { name: 'Tickets' }).click();
  await other.getByLabel('Search tickets').fill(foreign.publicNo);
  await expect(other.getByRole('button', { name: new RegExp(foreign.publicNo) })).toBeVisible();
  await other.context().close();

  await mkdir('test-results/phase3a', { recursive: true });
  for (const width of widths) {
    await manager.setViewportSize({ width, height: 800 });
    await nav.getByRole('button', { name: 'Attention' }).click();
    await expect(manager.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
    const overflow = await manager.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await manager.screenshot({ path: `test-results/phase3a/attention-${width}.png` });
    await nav.getByRole('button', { name: 'Queue' }).click();
    await expect.poll(async () => manager.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await manager.screenshot({ path: `test-results/phase3a/queue-${width}.png` });
    await nav.getByRole('button', { name: 'Staff' }).click();
    await expect.poll(async () => manager.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await manager.screenshot({ path: `test-results/phase3a/staff-${width}.png` });
  }
  await manager.context().close();
});

async function openManager(browser: Browser, email: string, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await context.addCookies([{ name: 'eveops_session', value: token, url: webOrigin }]);
  await page.goto('/hall-manager');
  return page;
}

async function raiseTicket(key: string, email: string, category: string, subtype: string, priority: 'NORMAL' | 'URGENT') {
  const stall = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = randomBytes(32).toString('base64url');
  await prisma.session.create({
    data: {
      userId: stall.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const response = await fetch(`${apiOrigin}/api/tickets`, {
    method: 'POST',
    headers: { cookie: `eveops_session=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      category,
      subtype,
      description: 'Phase 3A hall manager check',
      priority,
      idempotencyKey: key,
    }),
  });
  if (response.status !== 201) throw new Error(`Ticket create failed with status ${response.status}`);
  return response.json() as Promise<{ id: string; publicNo: string; status: string }>;
}

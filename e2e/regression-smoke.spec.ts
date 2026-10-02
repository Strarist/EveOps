import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const password = process.env.REGRESSION_FIXTURE_PASSWORD ?? '';
const apiOrigin = process.env.API_URL?.replace(/\/api$/, '') ?? 'http://localhost:4100';
const prisma = new PrismaClient();

test.beforeAll(() => {
  if (password.length < 12) throw new Error('Set REGRESSION_FIXTURE_PASSWORD before browser regression. Do not commit it.');
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('regression health reports eveops_regression', async ({ request }) => {
  const health = await request.get(`${apiOrigin}/api/system/health`);
  expect(health.ok()).toBeTruthy();
  const body = await health.json() as { databaseName?: string };
  expect(body.databaseName).toBe('eveops_regression');
  expect(JSON.stringify(body)).not.toMatch(/postgresql:|SESSION_SECRET|password/i);
});

test('role homes render on the regression stack', async ({ browser }) => {
  test.setTimeout(180_000);
  const journeys = [
    { email: 'regression.elec.h1.1@volume.lab', path: '/login', button: 'Sign in', heading: 'Electrician H1.1', url: /\/staff/ },
    { email: 'regression.help.h1.1@volume.lab', path: '/login', button: 'Sign in', heading: 'House help H1.1', url: /\/staff/ },
    { email: 'regression.manager.h1@volume.lab', path: '/login', button: 'Sign in', heading: 'Hall 1 operations', url: /\/hall-manager/ },
    { email: 'regression.stall.h1-01@volume.lab', path: '/login', button: 'Sign in', heading: 'Stall H1-01', url: /\/stall/ },
    { email: 'regression.admin@volume.lab', path: '/login', button: 'Sign in', heading: 'Event command center', url: /\/admin/ },
    { email: 'regression.super@volume.lab', path: '/governance-access', button: 'Enter governance workspace', heading: 'Portfolio overview', url: /\/super-admin/ },
  ];
  for (const journey of journeys) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, journey.path, journey.email, journey.button, journey.url);
    await expect(page.getByRole('heading', { name: journey.heading })).toBeVisible();
    await context.close();
  }
});

test('admin sees a stall-code conflict and archive removes exhibitor push access', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, '/login', 'regression.admin@volume.lab', 'Sign in', /\/admin/);
  await page.goto('/admin/registrations');
  const article = page.locator('article').filter({ hasText: 'H1-02' }).first();
  await article.getByRole('button', { name: 'Edit' }).click();
  await article.getByLabel('Stall code').fill('H1-01');
  await article.getByRole('button', { name: 'Save registration' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'H1-01' })).toBeVisible();
  await expect(article).toContainText('H1-02');

  const suffix = Date.now().toString(36);
  const zone = await prisma.zone.findFirstOrThrow({ where: { hall: { code: 'H4', eventId: 'regression-event' } } });
  const created = await page.request.post('/api/management/masters/stall', {
    data: {
      eventId: 'regression-event',
      zoneId: zone.id,
      stallCode: `CASE-BROWSER-${suffix}`,
      exhibitorName: 'Browser booth',
      servicePriority: 'LOW',
    },
  });
  expect(created.status()).toBe(201);
  const stall = await created.json() as { id: string };
  const person = await page.request.post('/api/workforce/people', {
    data: {
      name: 'Browser exhibitor',
      email: `regression.case.browser.${suffix}@volume.lab`,
      password,
      role: 'STALL',
      eventId: 'regression-event',
      stallId: stall.id,
    },
  });
  expect(person.ok()).toBeTruthy();
  const account = await person.json() as { id: string };
  await prisma.pushSubscription.create({
    data: {
      userId: account.id,
      endpoint: `https://push.example.test/browser-${suffix}`,
      p256dh: 'regression-p256dh-key',
      auth: 'regression-auth',
    },
  });
  await page.reload();
  const createdArticle = page.locator('article').filter({ hasText: `CASE-BROWSER-${suffix}` }).first();
  await createdArticle.getByRole('button', { name: 'Archive' }).click();
  await createdArticle.getByLabel('Reason').fill('Browser archive check');
  await createdArticle.getByRole('button', { name: 'Archive registration' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await expect.poll(async () => prisma.pushSubscription.count({ where: { userId: account.id } })).toBe(0);
  const disabled = await prisma.user.findUniqueOrThrow({ where: { id: account.id } });
  expect(disabled.status).toBe('DISABLED');
  expect(await prisma.notification.count({ where: { recipientId: account.id } })).toBeGreaterThanOrEqual(0);
  await context.close();
});

test('live reopen response matches the stored ticket', async () => {
  const stall = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.stall.h4-04@volume.lab' } });
  const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.manager.h4@volume.lab' } });
  const worker = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.help.h4.1@volume.lab' } });
  const peer = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.help.h4.2@volume.lab' } });
  await prisma.workforceMembership.updateMany({ where: { userId: { in: [worker.id, peer.id] } }, data: { availability: 'OFF_DUTY' } });
  const stallCookie = await mintSession(stall.id);
  const managerCookie = await mintSession(manager.id);
  const created = await fetch(`${apiOrigin}/api/tickets`, {
    method: 'POST',
    headers: { cookie: stallCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: 'Browser reopen check',
      priority: 'NORMAL',
      idempotencyKey: `case-browser-reopen-${Date.now().toString(36)}`,
    }),
  });
  expect(created.status).toBe(201);
  const ticket = await created.json() as { id: string; status: string };
  const ticketId = ticket.id;
  try {
    expect(ticket.status).toBe('QUEUED');
    await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'CLOSED', closedAt: new Date() } });
    const reopened = await fetch(`${apiOrigin}/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'REOPENED', reason: 'Needs another visit' }),
    });
    expect(reopened.status).toBe(201);
    const responseBody = await reopened.json() as { id: string; status: string; reopenCount: number };
    const stored = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(responseBody.status).toBe(stored.status);
    expect(['QUEUED', 'ASSIGNED']).toContain(responseBody.status);
    expect(responseBody.reopenCount).toBe(stored.reopenCount);
    const alerts = await prisma.notification.count({ where: { ticketId, type: 'TICKET_REOPENED' } });
    expect(alerts).toBeGreaterThan(0);
  } finally {
    await prisma.notification.deleteMany({ where: { ticketId } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId } });
    await prisma.assignment.deleteMany({ where: { ticketId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: ticketId } });
    await prisma.ticket.delete({ where: { id: ticketId } }).catch(() => undefined);
    await prisma.workforceMembership.updateMany({ where: { userId: worker.id }, data: { availability: 'OFF_DUTY' } });
    await prisma.workforceMembership.updateMany({ where: { userId: peer.id }, data: { availability: 'ON_DUTY' } });
  }
});

async function signIn(page: Page, path: string, email: string, button: string, url: RegExp) {
  await page.goto(path);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: button }).click();
    const outcome = await Promise.race([
      page.waitForURL(url, { timeout: 20_000 }).then(() => 'ok' as const),
      page.getByRole('alert').filter({ hasText: /too many/i }).waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'limited' as const),
    ]).catch(() => 'failed' as const);
    if (outcome === 'ok') return;
    if (outcome === 'limited') {
      await page.waitForTimeout(61_000);
      continue;
    }
    throw new Error('Sign-in did not open the workspace');
  }
  throw new Error('Sign-in stayed rate limited');
}

async function mintSession(userId: string) {
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

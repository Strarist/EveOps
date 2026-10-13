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
    throw new Error('Exhibitor checks require the isolated eveops_regression database.');
  }
});

const formDescriptions = ['Double click should create one request', 'Uncertain network should retry the same request'];

async function phase3bTickets() {
  return prisma.ticket.findMany({
    where: {
      OR: [
        { idempotencyKey: { startsWith: 'phase3b-' } },
        { description: { in: formDescriptions } },
      ],
    },
    select: { id: true },
  });
}

test.afterAll(async () => {
  const created = await phase3bTickets();
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
    where: { user: { email: 'regression.help.h1.1@volume.lab' } },
    data: { availability: 'ON_DUTY', capacity: 1 },
  });
  await prisma.$disconnect();
});

test('exhibitor can request help, open older requests, and confirm work from the request', async ({ browser }) => {
  test.setTimeout(240_000);
  const previous = await phase3bTickets();
  const previousIds = previous.map((ticket) => ticket.id);
  if (previousIds.length) {
    await prisma.notification.deleteMany({ where: { ticketId: { in: previousIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: previousIds } } });
    await prisma.assignment.deleteMany({ where: { ticketId: { in: previousIds } } });
    await prisma.otpChallenge.deleteMany({ where: { ticketId: { in: previousIds } } });
    await prisma.complaint.deleteMany({ where: { ticketId: { in: previousIds } } });
    await prisma.ticket.deleteMany({ where: { id: { in: previousIds } } });
  }
  const stallUser = await prisma.user.findUniqueOrThrow({
    where: { email: 'regression.stall.h1-01@volume.lab' },
    include: { scopes: true },
  });
  const scope = stallUser.scopes.find((item) => item.stallId);
  if (!scope?.stallId || !scope.hallId) throw new Error('Stall scope missing');
  const stallRow = await prisma.stall.findUniqueOrThrow({ where: { id: scope.stallId } });
  const helpPool = await prisma.servicePool.findFirstOrThrow({ where: { hallId: scope.hallId, category: 'HOUSE_HELP', subtype: 'General' } });
  const now = Date.now();
  await prisma.ticket.createMany({
    data: Array.from({ length: 55 }, (_, index) => ({
      publicNo: `P3B-H-${String(index).padStart(4, '0')}`,
      eventId: stallRow.eventId,
      hallId: scope.hallId!,
      zoneId: stallRow.zoneId,
      stallId: stallRow.id,
      poolId: helpPool.id,
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: index === 0 ? 'Older aisle request outside the first page' : 'Historical stall request',
      priority: 'NORMAL' as const,
      servicePriority: 'MEDIUM' as const,
      status: 'IN_PROGRESS' as const,
      createdById: stallUser.id,
      idempotencyKey: `phase3b-history-${index}`,
      createdAt: new Date(now - (80 - index) * 1000),
    })),
  });
  const older = await prisma.ticket.findFirstOrThrow({ where: { idempotencyKey: 'phase3b-history-0' } });

  const page = await openSession(browser, 'regression.stall.h1-01@volume.lab', 390);
  const staff = await openSession(browser, 'regression.help.h1.1@volume.lab', 390);
  await staff.goto('/staff');
  await expect(staff.getByRole('button', { name: 'Enable work alerts and continue' })).toBeVisible();
  await staff.context().close();
  const payloads: string[] = [];
  page.on('response', async (response) => {
    if (!response.url().includes('/api/tickets')) return;
    const text = await response.text().catch(() => '');
    if (/"otp"\s*:/.test(text)) return;
    payloads.push(text);
  });
  await page.goto('/stall');
  await expect(page.getByRole('heading', { name: /Stall H1-01/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request help' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active requests' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent completions' })).toBeVisible();
  await expect(page.getByText('P3B-H-0000')).toHaveCount(0);

  await mkdir('test-results/phase3b', { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/stall');
    await expect(page.getByRole('heading', { name: /Stall H1-01/ })).toBeVisible();
    await expect(page.getByText('Loading your requests…')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/phase3b/home-${width}.png` });
    await page.goto('/stall/requests?view=active');
    await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
    await expect(page.getByText('Loading your requests…')).toHaveCount(0);
    await page.screenshot({ path: `test-results/phase3b/requests-${width}.png` });
    await page.goto('/stall/request');
    await expect(page.getByRole('heading', { name: 'Request help' })).toBeVisible();
    const submitBox = page.getByRole('button', { name: 'Request help' });
    await submitBox.scrollIntoViewIfNeeded();
    const covered = await submitBox.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, Math.min(rect.bottom - 4, window.innerHeight - 4));
      return Boolean(target && target.closest('.bottom-nav') && !element.contains(target));
    });
    expect(covered).toBe(false);
    await page.screenshot({ path: `test-results/phase3b/request-${width}.png` });
    await page.goto('/stall/profile');
    await expect(page.getByRole('heading', { name: 'Profile and help' })).toBeVisible();
    await page.screenshot({ path: `test-results/phase3b/profile-${width}.png` });
    await page.goto('/stall/ticket/' + older.id);
    await expect(page.getByRole('heading', { name: older.publicNo })).toBeVisible();
    await page.screenshot({ path: `test-results/phase3b/detail-${width}.png`, mask: [page.locator('.completion-code')] });
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/stall');
  await page.goto('/stall/ticket/' + older.id);
  await expect(page.getByRole('heading', { name: older.publicNo })).toBeVisible();
  await expect(page.getByText('Older aisle request outside the first page')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/stall$/);

  await page.goto('/stall/requests?view=all&q=P3B-H-0000');
  await expect(page.getByRole('link', { name: /P3B-H-0000/ })).toBeVisible();
  await page.getByRole('link', { name: /P3B-H-0000/ }).click();
  await expect(page).toHaveURL(new RegExp('/stall/ticket/' + older.id));
  await page.goBack();
  await expect(page).toHaveURL(/view=all/);
  await expect(page).toHaveURL(/q=P3B-H-0000/);

  await page.goto('/stall/request');
  await page.getByRole('radio', { name: 'House Help' }).check();
  await page.getByLabel('What needs attention?').fill('Double click should create one request');
  let posts = 0;
  await page.route('**/api/tickets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1;
    if (posts === 1) await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  const submit = page.getByRole('button', { name: 'Request help' });
  await submit.click();
  await submit.click({ timeout: 1000 }).catch(() => undefined);
  await expect(page.getByRole('heading', { name: 'Request received.' })).toBeVisible();
  expect(posts).toBe(1);
  await page.unroute('**/api/tickets');
  const view = page.getByRole('link', { name: 'View request' });
  const href = await view.getAttribute('href');
  expect(href).toMatch(/^\/stall\/ticket\//);
  await view.click();
  await expect(page).toHaveURL(new RegExp(href!));
  await expect(page.getByText(/Waiting for assignment|Hall Manager notified|server confirmed/i)).toHaveCount(0);

  await page.goto('/stall/request');
  await page.getByRole('radio', { name: 'Electrical' }).check();
  await page.getByRole('radio', { name: 'Lighting' }).check();
  const description = page.getByLabel('What needs attention?');
  await description.fill('Uncertain network should retry the same request');
  let aborted = false;
  await page.route('**/api/tickets', async (route) => {
    if (route.request().method() === 'POST' && !aborted) {
      aborted = true;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Request help' }).click();
  await expect(page.getByText('We could not confirm whether this request was saved.')).toBeVisible();
  await expect(description).toHaveValue('Uncertain network should retry the same request');
  await page.unroute('**/api/tickets');
  await page.getByRole('button', { name: 'Request help' }).click();
  await expect(page.getByRole('heading', { name: 'Request received.' })).toBeVisible();
  const retried = await prisma.ticket.count({ where: { description: 'Uncertain network should retry the same request', stallId: stallRow.id } });
  expect(retried).toBe(1);

  await prisma.workforceMembership.updateMany({
    where: { user: { email: 'regression.help.h1.1@volume.lab' } },
    data: { availability: 'ON_DUTY', capacity: 4 },
  });
  const worker = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.help.h1.1@volume.lab' } });
  const awaiting = await raiseAndAdvance(stallUser.id, worker.id, 'phase3b-awaiting', 'Awaiting code outside the home preview');
  await prisma.ticket.update({ where: { id: awaiting.id }, data: { createdAt: new Date(now - 86_400_000) } });
  await page.goto('/stall');
  await expect(page.getByText(awaiting.publicNo)).toHaveCount(0);
  await page.goto('/stall/ticket/' + awaiting.id);
  await expect(page.getByText('Check the work, then share the completion code with the assigned worker or hall manager.')).toBeVisible();
  await page.getByRole('button', { name: 'Show completion code' }).click();
  const code = page.locator('.completion-code');
  await expect(code).toHaveText(/^\d{6}$/);
  const otp = await code.innerText();
  const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.manager.h1@volume.lab' } });
  const managerToken = await sessionToken(manager.email);
  const verified = await fetch(`${apiOrigin}/api/tickets/${awaiting.id}/otp/verify`, {
    method: 'POST',
    headers: { cookie: `eveops_session=${managerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ otp }),
  });
  expect(verified.ok).toBe(true);
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 15_000 });

  const complained = await raiseAndAdvance(stallUser.id, worker.id, 'phase3b-complaint', 'Work to complain about');
  await page.goto('/stall/ticket/' + complained.id);
  await page.getByText('Report a problem').click();
  await page.getByLabel('What is still wrong?').selectOption('WORK_INCOMPLETE');
  await page.getByRole('button', { name: 'Submit report' }).click();
  await expect(page.getByText('Problem reported', { exact: true })).toBeVisible();
  await expect(page.getByText(/does not by itself reopen/)).toBeVisible();
  const managerScopeToken = managerToken;
  const reopened = await fetch(`${apiOrigin}/api/tickets/${complained.id}/transition`, {
    method: 'POST',
    headers: { cookie: `eveops_session=${managerScopeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'REOPENED', reason: 'Open it again after the report' }),
  });
  expect(reopened.ok).toBe(true);
  await expect(page.getByText(/Request reopened|Waiting for assistance|Staff assigned|Request received/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/^Completed /)).toHaveCount(0);

  const other = await openSession(browser, 'regression.stall.h1-02@volume.lab', 390);
  await other.goto('/stall/ticket/' + older.id);
  await expect(other.getByText('This request is no longer available for your stall.')).toBeVisible();
  await other.context().close();

  await prisma.ticket.update({ where: { id: older.id }, data: { stallId: (await prisma.stall.findFirstOrThrow({ where: { stallCode: 'H1-02' } })).id } });
  await page.goto('/stall/ticket/' + older.id);
  await expect(page.getByText('This request is no longer available for your stall.')).toBeVisible();
  await prisma.ticket.update({ where: { id: older.id }, data: { stallId: stallRow.id } });

  await page.route('**/api/tickets/' + older.id, (route) => route.abort('failed'));
  await page.goto('/stall/ticket/' + older.id);
  await expect(page.getByText('This request could not be loaded')).toBeVisible();
  await page.unroute('**/api/tickets/' + older.id);
  await page.getByRole('alert').filter({ hasText: 'This request could not be loaded' }).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: older.publicNo })).toBeVisible();

  await page.context().setOffline(true);
  await expect(page.getByText('Reconnecting')).toBeVisible({ timeout: 10_000 });
  await page.context().setOffline(false);
  await expect(page.getByText('Live')).toBeVisible({ timeout: 15_000 });

  expect(payloads.join('\n')).not.toMatch(/"servicePriority"|"slaState"|"queuePriorityOverrideAt"|"snoozedUntil"|"escalationLevel"/);

  await page.context().clearCookies();
  await page.goto('/stall');
  await expect(page).toHaveURL(/\/login/);
  await page.context().close();
});

async function openSession(browser: Browser, email: string, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
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

async function raiseAndAdvance(stallUserId: string, workerId: string, key: string, description: string) {
  const token = await sessionToken('regression.stall.h1-01@volume.lab');
  const response = await fetch(`${apiOrigin}/api/tickets`, {
    method: 'POST',
    headers: { cookie: `eveops_session=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      category: 'HOUSE_HELP',
      subtype: 'General',
      description,
      priority: 'NORMAL',
      idempotencyKey: key,
    }),
  });
  if (response.status !== 201) throw new Error(`Ticket create failed with status ${response.status}`);
  const created = await response.json() as { id: string; publicNo: string };
  const workerToken = await sessionToken('regression.help.h1.1@volume.lab');
  for (const to of ['ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP']) {
    const step = await fetch(`${apiOrigin}/api/tickets/${created.id}/transition`, {
      method: 'POST',
      headers: { cookie: `eveops_session=${workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (!step.ok) throw new Error(`Transition to ${to} failed with status ${step.status}`);
  }
  void stallUserId;
  void workerId;
  return created;
}

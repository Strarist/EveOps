import { expect, test, type Browser, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const apiOrigin = process.env.API_URL?.replace(/\/api$/, '') ?? 'http://localhost:4100';
const webOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:3110';
const prisma = new PrismaClient();
const sessionHashes: string[] = [];
const widths = [360, 390, 768, 1024, 1440];

test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const health = await fetch(`${apiOrigin}/api/system/health`);
  const body = await health.json() as { databaseName?: string };
  if (body.databaseName !== 'eveops_regression') throw new Error('Admin checks require the isolated eveops_regression database.');
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
      publicNo: `P3C-${String(index).padStart(4, '0')}`,
      eventId: stallRow.eventId,
      hallId: scope.hallId!,
      zoneId: stallRow.zoneId,
      stallId: stallRow.id,
      poolId: pool.id,
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: 'Admin pagination sample',
      priority: 'NORMAL' as const,
      servicePriority: 'MEDIUM' as const,
      status: 'QUEUED' as const,
      createdById: stall.id,
      idempotencyKey: `phase3c-page-${index}`,
      createdAt: new Date(now - (80 - index) * 1000),
    })),
  });
  const activityTicket = await prisma.ticket.create({
    data: {
      publicNo: 'P3C-ACT',
      eventId: stallRow.eventId,
      hallId: scope.hallId,
      zoneId: stallRow.zoneId,
      stallId: stallRow.id,
      poolId: pool.id,
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: 'Admin activity pagination sample',
      priority: 'NORMAL',
      servicePriority: 'MEDIUM',
      status: 'IN_PROGRESS',
      createdById: stall.id,
      idempotencyKey: 'phase3c-activity',
    },
  });
  await prisma.ticketEvent.createMany({
    data: Array.from({ length: 25 }, (_, index) => ({
      eventId: stallRow.eventId,
      ticketId: activityTicket.id,
      eventType: 'TICKET_CREATED',
      actorId: stall.id,
      correlationId: `phase3c-activity-${index}`,
      createdAt: new Date(now + index * 1000),
    })),
  });
});

test.afterAll(async () => {
  await cleanupSeed();
  await cleanupRegistration();
  if (sessionHashes.length) await prisma.session.deleteMany({ where: { tokenHash: { in: sessionHashes } } });
  await prisma.$disconnect();
});

test('admin sections, ticket scope, and pagination stay inside the event', async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await openSession(browser, 'regression.admin@volume.lab', 1440);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.locator('.eyebrow').first()).toContainText('Volume Lab Expo · This event');
  await expect(page.locator('.metric strong').first()).not.toHaveText('—');
  await expect(page.locator('.admin-ticket-table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review records' }).first()).toBeVisible();
  await expect(page.getByText('No single ticket filter matches this count.').first()).toBeVisible();

  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('button', { name: 'Tickets' }).click();
  await expect(page).toHaveURL(/section=Tickets/);
  const list = await page.request.get('/api/tickets?view=all&limit=50');
  expect(list.ok()).toBeTruthy();
  const listed = await list.json() as { total: number; items: Array<{ id: string; publicNo: string; eventId?: string }> };
  expect(listed.total).toBeGreaterThan(50);
  await expect(page.locator('.operations .section-title p')).toContainText(`${listed.total} tickets`);
  await expect(page.locator('.operations .section-title p')).toContainText(`Showing ${listed.items.length}`);
  const before = listed.items.length;
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect.poll(async () => showingCount(page)).toBeGreaterThan(before);
  const after = await showingCount(page);
  expect(after).toBeLessThanOrEqual(listed.total);

  await page.getByLabel('Status filter').selectOption('QUEUED');
  await expect(page).toHaveURL(/status=QUEUED/);
  const queued = await page.request.get('/api/tickets?view=all&status=QUEUED&limit=50');
  const queuedBody = await queued.json() as { total: number };
  await expect(page.locator('.operations .section-title p')).toContainText(`${queuedBody.total} tickets`);
  await page.goBack();
  await expect(page).not.toHaveURL(/status=QUEUED/);
  await expect(page.getByLabel('Status filter')).toHaveValue('');

  await page.goto('/admin?section=Tickets&ticket=' + encodeURIComponent((await prisma.ticket.findFirstOrThrow({ where: { publicNo: 'P3C-ACT' } })).id));
  const drawer = page.getByRole('complementary', { name: /P3C-ACT detail/ });
  await expect(drawer).toBeVisible();
  const activity = drawer.getByRole('region', { name: 'Activity' });
  await expect(activity.getByRole('heading', { name: 'Activity', level: 3 })).toBeVisible();
  await expect(activity.locator('.timeline-item')).toHaveCount(20);
  await activity.getByRole('button', { name: 'Load more' }).click();
  await expect(activity.locator('.timeline-item')).toHaveCount(25);
  await drawer.getByRole('button', { name: 'Back to the list' }).click();
  await expect(page).not.toHaveURL(/ticket=/);
  await expect(drawer).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('button', { name: 'Workforce' }).click();
  await expect(page.getByRole('heading', { name: 'Workforce', level: 1 })).toBeVisible();
  await expect(page.getByText('Duty').first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('button', { name: 'Event setup' }).click();
  await expect(page.getByRole('heading', { name: 'Event setup', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add stall' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open registrations' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByText('a dash means there is no completed sample')).toBeVisible();
  await page.getByRole('navigation', { name: 'Admin navigation' }).getByRole('button', { name: 'Audit' }).click();
  await expect(page.getByRole('heading', { name: 'Administrative history', level: 2 })).toBeVisible();

  await page.goto('/admin/registrations');
  await expect(page.getByRole('heading', { name: 'Registrations', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Register a stall and login' })).toBeVisible();
  const vacant = page.locator('article').filter({ hasText: 'H4-VACANT' }).first();
  await expect(vacant.getByText('No exhibitor login yet')).toBeVisible();
  await expect(vacant.getByRole('button', { name: 'Create exhibitor login' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Exhibitor login instructions' })).toHaveCount(0);

  const manager = await openSession(browser, 'regression.manager.h1@volume.lab', 1280);
  await manager.goto('/admin');
  await expect(manager).toHaveURL(/\/hall-manager/);
  await expect(manager.getByRole('heading', { name: 'Hall 1 operations' })).toBeVisible();
  const superAdmin = await openSession(browser, 'regression.super@volume.lab', 1280);
  await superAdmin.goto('/admin/registrations');
  await expect(superAdmin).toHaveURL(/\/super-admin/);

  await mkdir('test-results/phase3c-admin', { recursive: true });
  const shots: Array<[string, string]> = [
    ['/admin?section=Overview', 'overview'],
    ['/admin?section=Tickets', 'tickets'],
    ['/admin?section=Workforce', 'workforce'],
    ['/admin?section=Event%20setup', 'event-setup'],
    ['/admin?section=Reports', 'reports'],
    ['/admin?section=Audit', 'audit'],
    ['/admin/registrations', 'registrations'],
  ];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, name] of shots) {
      await page.goto(path);
      if (await page.getByText('Your session is still valid.').count()) {
        await page.waitForTimeout(65_000);
        await page.goto(path);
      }
      await expect(page.locator('h1').first()).toBeVisible();
      if (name === 'overview') await expect(page.locator('.metric strong').first()).not.toHaveText('—');
      if (name === 'tickets') await expect(page.locator('.operations .section-title p')).toContainText(/Showing [1-9]/);
      if (name === 'workforce') await expect(page.getByText('Duty').first()).toBeVisible();
      if (name === 'reports') await expect(page.getByText('Hall figures have not loaded.')).toHaveCount(0);
      if (name === 'registrations') await expect(page.getByText('H1-01').first()).toBeVisible();
      if (name === 'audit') await expect(page.getByText(/No history matches|Administrative change|Ticket lifecycle/).first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${name} at ${width}px`).toBeLessThanOrEqual(8);
      await page.screenshot({ path: `test-results/phase3c-admin/${name}-${width}.png` });
    }
    await page.goto('/admin?section=Event%20setup');
    await page.getByRole('button', { name: 'Add hall' }).click();
    await expect(page.getByRole('button', { name: 'Create hall' })).toBeVisible();
    const formOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(formOverflow, `add hall at ${width}px`).toBeLessThanOrEqual(8);
    await page.screenshot({ path: `test-results/phase3c-admin/add-hall-${width}.png` });
  }
  await page.context().close();
  await manager.context().close();
  await superAdmin.context().close();
});

test('registration, workforce approval, export, and session expiry stay in the admin event', async ({ browser }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString(36);
  const stallCode = `C3${suffix}`.slice(0, 20);
  const email = `regression.p3c.${suffix}@volume.lab`;
  const staffEmail = `regression.p3c.staff.${suffix}@volume.lab`;
  const personal = `Phase3c${suffix}a1`;
  const staffSecret = `Staff3c${suffix}a1`;

  const admin = await openSession(browser, 'regression.admin@volume.lab', 1280);
  await admin.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await admin.goto('/admin/registrations');
  const create = admin.locator('form.registration-create');
  await create.locator('select[name="zoneId"]').selectOption({ index: 1 });
  await create.locator('input[name="stallCode"]').fill(stallCode);
  await create.locator('input[name="exhibitorName"]').fill('Phase 3C booth');
  await create.locator('input[name="contact"]').fill('Front desk');
  await create.locator('select[name="servicePriority"]').selectOption('HIGH');
  await create.locator('input[name="loginName"]').fill('Phase 3C exhibitor');
  await create.locator('input[name="loginEmail"]').fill(email);
  const createdResponse = admin.waitForResponse((response) => response.url().includes('/with-login') && response.request().method() === 'POST');
  await create.getByRole('button', { name: 'Create stall and exhibitor login' }).click();
  const created = await createdResponse;
  expect(created.ok()).toBeTruthy();
  const createdBody = created.request().postDataJSON() as Record<string, string>;
  const handoff = admin.getByRole('status', { name: 'Exhibitor login instructions' });
  await expect(handoff).toBeVisible();
  const initial = await handoff.locator('dd').nth(2).innerText();
  expect(initial.length).toBeGreaterThan(8);
  await handoff.getByRole('button', { name: 'Copy login instructions' }).click();
  await expect(handoff.getByRole('button', { name: 'Copied' })).toBeVisible();
  await handoff.getByRole('button', { name: 'Dismiss' }).click();
  await expect(handoff).toHaveCount(0);

  const replay = await admin.evaluate(async (body) => {
    const response = await fetch('/api/management/registrations/with-login', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await response.json() as { created?: boolean; credentialIssued?: boolean; handoff?: { initialCredential?: string | null } };
    return { status: response.status, created: payload.created === true, credentialIssued: payload.credentialIssued === true, showsCredential: Boolean(payload.handoff?.initialCredential) };
  }, createdBody);
  expect(replay).toEqual({ status: 201, created: false, credentialIssued: false, showsCredential: false });

  await create.locator('select[name="zoneId"]').selectOption({ index: 1 });
  await create.locator('input[name="stallCode"]').fill(stallCode);
  await create.locator('input[name="exhibitorName"]').fill('Phase 3C booth');
  await create.locator('input[name="loginName"]').fill('Phase 3C duplicate');
  await create.locator('input[name="loginEmail"]').fill(`other.${suffix}@volume.lab`);
  await create.getByRole('button', { name: 'Create stall and exhibitor login' }).click();
  await expect(admin.getByRole('alert').filter({ hasText: stallCode })).toBeVisible();

  await admin.reload();
  const row = admin.locator('article').filter({ hasText: stallCode }).first();
  await expect(row.getByText(stallCode)).toBeVisible();
  await expect(row.getByText('password change required')).toBeVisible();
  await row.getByRole('button', { name: 'Edit' }).click();
  await row.locator('select[name="servicePriority"]').selectOption('LOW');
  await row.getByRole('button', { name: 'Save registration' }).click();
  await expect(row.getByText('LOW', { exact: true })).toBeVisible();

  const exhibitor = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const stallPage = await exhibitor.newPage();
  await stallPage.goto('/login');
  await stallPage.locator('input[name="email"]').fill(email);
  await stallPage.locator('input[name="password"]').fill(initial);
  await stallPage.getByRole('button', { name: 'Sign in' }).click();
  await stallPage.waitForURL(/\/change-password/);
  await stallPage.locator('input[name="currentPassword"]').fill(initial);
  await stallPage.locator('input[name="newPassword"]').fill(personal);
  await stallPage.locator('input[name="confirmPassword"]').fill(personal);
  await stallPage.getByRole('button', { name: 'Save and continue' }).click();
  await stallPage.waitForURL(/\/stall/);
  await expect(stallPage.getByRole('heading', { name: `Stall ${stallCode}` })).toBeVisible();

  await row.getByRole('button', { name: 'Reset initial password' }).click();
  await row.getByRole('button', { name: 'Reset and sign out earlier sessions' }).click();
  const resetHandoff = admin.getByRole('status', { name: 'Exhibitor login instructions' });
  await expect(resetHandoff).toBeVisible();
  await resetHandoff.getByRole('button', { name: 'Dismiss' }).click();
  await stallPage.reload();
  await stallPage.waitForURL(/\/login/);

  const stallRow = await prisma.stall.findFirstOrThrow({ where: { stallCode }, include: { zone: true } });
  const creator = await prisma.user.findUniqueOrThrow({ where: { email } });
  const pool = await prisma.servicePool.findFirstOrThrow({ where: { hallId: stallRow.zone.hallId, category: 'HOUSE_HELP', subtype: 'General' } });
  const openTicket = await prisma.ticket.create({
    data: {
      publicNo: `C3-OPEN-${suffix}`.slice(0, 24),
      eventId: stallRow.eventId,
      hallId: stallRow.zone.hallId,
      zoneId: stallRow.zoneId,
      stallId: stallRow.id,
      poolId: pool.id,
      category: 'HOUSE_HELP',
      subtype: 'General',
      description: 'Open work blocking archive',
      status: 'NEW',
      createdById: creator.id,
      idempotencyKey: `phase3c-open-${suffix}`,
    },
  });
  await admin.reload();
  const blocked = admin.locator('article').filter({ hasText: stallCode }).first();
  await expect(blocked.getByRole('button', { name: 'Transfer exhibitor', exact: true })).toBeDisabled();
  await expect(blocked.getByRole('button', { name: 'Archive', exact: true })).toBeDisabled();
  await expect(blocked.getByRole('link', { name: /Review this stall/ })).toBeVisible();
  await prisma.ticketEvent.deleteMany({ where: { ticketId: openTicket.id } });
  await prisma.ticket.delete({ where: { id: openTicket.id } });
  await admin.reload();
  const clearRow = admin.locator('article').filter({ hasText: stallCode }).first();
  await clearRow.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(clearRow.getByText('removes its exhibitor login')).toBeVisible();
  await clearRow.locator('textarea[name="reason"]').fill('Booth left the hall');
  await clearRow.getByRole('button', { name: 'Archive registration' }).click();
  await expect(clearRow.getByText('Archived')).toBeVisible();

  const manager = await openSession(browser, 'regression.manager.h1@volume.lab', 1280);
  const hall = await prisma.hall.findFirstOrThrow({ where: { code: 'H1', eventId: 'regression-event' } });
  const staffResponse = await manager.request.post('/api/workforce/people', {
    data: {
      name: 'Phase 3C staff',
      email: staffEmail,
      password: staffSecret,
      role: 'STAFF',
      eventId: 'regression-event',
      hallId: hall.id,
      capacity: 1,
      serviceCategory: 'HOUSE_HELP',
      serviceSubtype: 'General',
    },
  });
  expect(staffResponse.ok()).toBeTruthy();
  await gotoReady(admin, '/admin?section=Workforce');
  const approval = admin.locator('article').filter({ hasText: 'Phase 3C staff' }).first();
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByText('Phase 3C staff').first()).toBeVisible();

  await gotoReady(admin, '/admin?section=Reports');
  await admin.getByRole('button', { name: 'Queue CSV export' }).click();
  const download = admin.getByRole('link', { name: 'Download' }).first();
  await expect(download).toBeVisible({ timeout: 20_000 });
  const file = await admin.request.get(await download.getAttribute('href') ?? '');
  expect(file.ok()).toBeTruthy();
  expect(await file.text()).toContain('ticket_number');
  await gotoReady(admin, '/admin?section=Tickets');
  await admin.getByLabel('Search tickets').fill('P3C-NO-SUCH-TICKET');
  await expect(admin.getByText('No tickets match these filters.')).toBeVisible();
  await admin.getByRole('button', { name: 'Export this filter' }).click();
  await gotoReady(admin, '/admin?section=Reports');
  await expect.poll(async () => {
    const jobs = await admin.request.get('/api/management/exports');
    const body = await jobs.json() as Array<{ rowCount: number | null; status: string }>;
    return body.some((job) => job.status === 'READY' && job.rowCount === 0);
  }).toBeTruthy();
  const rejected = await admin.request.post('/api/management/exports', { data: { format: 'PDF', filters: {}, columns: [] } });
  expect(rejected.status()).toBe(400);

  const expiry = await openSession(browser, 'regression.admin@volume.lab', 1280);
  const cookie = (await expiry.context().cookies()).find((item) => item.name === 'eveops_session');
  if (!cookie) throw new Error('Admin session cookie missing');
  await prisma.session.deleteMany({ where: { tokenHash: createHash('sha256').update(cookie.value).digest('hex') } });
  await gotoReady(expiry, '/admin');
  await expect(expiry).toHaveURL(/\/login/);

  await exhibitor.close();
  await manager.context().close();
  await admin.context().close();
  await expiry.context().close();
});

async function showingCount(page: Page) {
  const text = await page.locator('.operations .section-title p').innerText();
  return Number(text.match(/Showing (\d+)/)?.[1] ?? 0);
}

async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  if (await page.getByText('Your session is still valid.').count()) {
    await page.waitForTimeout(65_000);
    await page.goto(path);
  }
}

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

async function cleanupRegistration() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: 'regression.p3c.' } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  const stalls = await prisma.stall.findMany({
    where: { stallCode: { startsWith: 'C3' } },
    select: { id: true },
  });
  const stallIds = stalls.map((stall) => stall.id);
  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [
        ...(stallIds.length ? [{ stallId: { in: stallIds } }] : []),
        ...(userIds.length ? [{ createdById: { in: userIds } }] : []),
        { idempotencyKey: { startsWith: 'phase3c-open-' } },
      ],
    },
    select: { id: true },
  });
  const ids = tickets.map((ticket) => ticket.id);
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.assignment.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.otpChallenge.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.complaint.deleteMany({ where: { ticketId: { in: ids } } });
    await prisma.ticket.deleteMany({ where: { id: { in: ids } } });
  }
  if (userIds.length) {
    await prisma.workforceMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (stallIds.length) await prisma.stall.deleteMany({ where: { id: { in: stallIds } } });
}

async function cleanupSeed() {
  const created = await prisma.ticket.findMany({
    where: { idempotencyKey: { startsWith: 'phase3c-' } },
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

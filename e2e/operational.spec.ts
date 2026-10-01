import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const prisma = new PrismaClient();
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const password = 'EveOpsE2E!2026';
const runKey = `e2e-${process.pid}-${Date.now()}`;
const ids = {
  organization: `${runKey}-organization`,
  event: `${runKey}-event`,
  hall: `${runKey}-hall`,
  zone: `${runKey}-zone`,
  stall: `${runKey}-stall`,
  otherStall: `${runKey}-other-stall`,
  stallUser: `${runKey}-stall-user`,
  otherStallUser: `${runKey}-other-stall-user`,
  staffUser: `${runKey}-staff-user`,
  houseStaffUser: `${runKey}-house-staff-user`,
  managerUser: `${runKey}-manager-user`,
  adminUser: `${runKey}-admin-user`,
  superUser: `${runKey}-super-user`,
  electricalPool: `${runKey}-electrical-pool`,
  housePool: `${runKey}-house-pool`,
  managerPool: `${runKey}-manager-pool`,
};
const emails = {
  stall: `${runKey}.stall@eveops.test`,
  otherStall: `${runKey}.stall-other@eveops.test`,
  staff: `${runKey}.staff@eveops.test`,
  houseStaff: `${runKey}.house@eveops.test`,
  manager: `${runKey}.manager@eveops.test`,
  admin: `${runKey}.admin@eveops.test`,
  super: `${runKey}.super@eveops.test`,
};

async function clearOperationalData() {
  const exportJobs = await prisma.exportJob.findMany({
    where: { requestedBy: { organizationId: ids.organization } },
    select: { storageKey: true },
  });
  await Promise.all(exportJobs.flatMap((job) =>
    job.storageKey ? [unlink(resolve(process.cwd(), 'exports', basename(job.storageKey))).catch(() => undefined)] : [],
  ));
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { user: { organizationId: ids.organization } } }),
    prisma.notification.deleteMany({ where: { eventId: ids.event } }),
    prisma.outboxEvent.deleteMany({ where: { eventId: ids.event } }),
    prisma.complaint.deleteMany({ where: { eventId: ids.event } }),
    prisma.otpChallenge.deleteMany({ where: { eventId: ids.event } }),
    prisma.ticketEvent.deleteMany({ where: { eventId: ids.event } }),
    prisma.assignment.deleteMany({ where: { eventId: ids.event } }),
    prisma.ticket.deleteMany({ where: { eventId: ids.event } }),
    prisma.exportJob.deleteMany({ where: { requestedBy: { organizationId: ids.organization } } }),
    prisma.managementAudit.deleteMany({ where: { organizationId: ids.organization } }),
    prisma.event.update({ where: { id: ids.event }, data: { ticketSequence: 0 } }),
    // Only fixture workers should be route-eligible between tests. Leftover people created
    // mid-suite (Admin/HM create flows) must stay OFF_DUTY so they cannot steal assignments.
    prisma.workforceMembership.updateMany({
      where: { eventId: ids.event, userId: { in: [ids.staffUser, ids.houseStaffUser, ids.managerUser] } },
      data: { availability: 'ON_DUTY', lastAvailableAt: new Date('2026-01-01T00:00:00Z') },
    }),
    prisma.workforceMembership.updateMany({
      where: { eventId: ids.event, userId: { notIn: [ids.staffUser, ids.houseStaffUser, ids.managerUser] } },
      data: { availability: 'OFF_DUTY' },
    }),
  ]);
}

async function prepareFixture() {
  const existing = await prisma.organization.findUnique({ where: { id: ids.organization } });
  if (existing) await destroyFixture();
  const passwordHash = await hash(password, 4);
  await prisma.organization.create({ data: { id: ids.organization, name: 'E2E Organization' } });
  await prisma.event.create({
    data: {
      id: ids.event,
      organizationId: ids.organization,
      name: 'E2E Expo',
      venue: 'Automated Test Venue',
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: new Date('2027-01-01T00:00:00Z'),
      timezone: 'Asia/Kolkata',
      status: 'ACTIVE',
    },
  });
  await prisma.hall.create({ data: { id: ids.hall, eventId: ids.event, code: 'E2E-H1', name: 'E2E Hall' } });
  await prisma.zone.create({ data: { id: ids.zone, eventId: ids.event, hallId: ids.hall, code: 'E2E-Z1' } });
  await prisma.stall.createMany({
    data: [
      { id: ids.stall, eventId: ids.event, zoneId: ids.zone, stallCode: 'E2E-S1', exhibitorName: 'E2E Stall' },
      { id: ids.otherStall, eventId: ids.event, zoneId: ids.zone, stallCode: 'E2E-S2', exhibitorName: 'Other E2E Stall' },
    ],
  });
  await prisma.user.createMany({
    data: [
      { id: ids.stallUser, organizationId: ids.organization, name: 'E2E Stall', email: emails.stall, passwordHash, role: 'STALL' },
      { id: ids.otherStallUser, organizationId: ids.organization, name: 'Other E2E Stall', email: emails.otherStall, passwordHash, role: 'STALL' },
      { id: ids.staffUser, organizationId: ids.organization, name: 'E2E Electrician', email: emails.staff, passwordHash, role: 'STAFF', employeeCode: 'STF-E2E-01' },
      { id: ids.houseStaffUser, organizationId: ids.organization, name: 'E2E House Help', email: emails.houseStaff, passwordHash, role: 'STAFF', employeeCode: 'STF-E2E-HH' },
      { id: ids.managerUser, organizationId: ids.organization, name: 'E2E Hall Manager', email: emails.manager, passwordHash, role: 'HALL_MANAGER', employeeCode: 'HM-E2E-01' },
      { id: ids.adminUser, organizationId: ids.organization, name: 'E2E Admin', email: emails.admin, passwordHash, role: 'ADMIN' },
      { id: ids.superUser, organizationId: ids.organization, name: 'E2E SuperAdmin', email: emails.super, passwordHash, role: 'SUPER_ADMIN' },
    ],
  });
  await prisma.userScope.createMany({
    data: [
      { userId: ids.stallUser, eventId: ids.event, hallId: ids.hall, stallId: ids.stall },
      { userId: ids.otherStallUser, eventId: ids.event, hallId: ids.hall, stallId: ids.otherStall },
      { userId: ids.staffUser, eventId: ids.event, hallId: ids.hall, serviceType: 'ELECTRICAL' },
      { userId: ids.houseStaffUser, eventId: ids.event, hallId: ids.hall, serviceType: 'HOUSE_HELP' },
      { userId: ids.managerUser, eventId: ids.event, hallId: ids.hall },
      { userId: ids.adminUser, eventId: ids.event },
      { userId: ids.superUser, eventId: ids.event },
    ],
  });
  await prisma.servicePool.createMany({
    data: [
      { id: ids.electricalPool, eventId: ids.event, hallId: ids.hall, category: 'ELECTRICAL', subtype: 'Lighting' },
      { id: ids.housePool, eventId: ids.event, hallId: ids.hall, category: 'HOUSE_HELP', subtype: 'General' },
      { id: ids.managerPool, eventId: ids.event, hallId: ids.hall, category: 'HALL_MANAGER', subtype: 'General' },
    ],
  });
  await prisma.workforceMembership.createMany({
    data: [
      { eventId: ids.event, poolId: ids.electricalPool, userId: ids.staffUser, availability: 'ON_DUTY', capacity: 1 },
      { eventId: ids.event, poolId: ids.housePool, userId: ids.houseStaffUser, availability: 'ON_DUTY', capacity: 1 },
      { eventId: ids.event, poolId: ids.managerPool, userId: ids.managerUser, availability: 'ON_DUTY', capacity: 1 },
    ],
  });
}

async function destroyFixture() {
  await clearOperationalData();
  await prisma.workforceMembership.deleteMany({ where: { eventId: ids.event } });
  await prisma.servicePool.deleteMany({ where: { eventId: ids.event } });
  await prisma.userScope.deleteMany({ where: { eventId: ids.event } });
  await prisma.stall.deleteMany({ where: { eventId: ids.event } });
  await prisma.zone.deleteMany({ where: { eventId: ids.event } });
  await prisma.hall.deleteMany({ where: { eventId: ids.event } });
  await prisma.event.delete({ where: { id: ids.event } });
  await prisma.user.deleteMany({ where: { organizationId: ids.organization } });
  await prisma.organization.delete({ where: { id: ids.organization } });
}

async function login(browser: Browser, email: string, portal: 'OPERATIONS' | 'GOVERNANCE' = 'OPERATIONS') {
  const context = await browser.newContext();
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, role: true } });
  if (portal === 'GOVERNANCE') expect(user.role).toBe('SUPER_ADMIN');
  const token = randomUUID() + randomUUID();
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await context.addCookies([{
    name: 'eveops_session',
    value: token,
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  return context;
}

async function createTicket(context: BrowserContext, category = 'ELECTRICAL', subtype = 'Lighting', stallId?: string) {
  const response = await context.request.post('/api/tickets', {
    data: {
      ...(stallId ? { stallId } : {}),
      category,
      subtype,
      description: `E2E request ${randomUUID()}`,
      priority: 'NORMAL',
      idempotencyKey: randomUUID(),
    },
  });
  const responseBody = await response.text();
  expect(response.status(), responseBody).toBe(201);
  return JSON.parse(responseBody) as { id: string; publicNo: string; status: string; reopenCount: number };
}

async function advanceToOtp(context: BrowserContext, ticketId: string) {
  for (const to of ['ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP']) {
    const response = await context.request.post(`/api/tickets/${ticketId}/transition`, { data: { to } });
    expect(response.status()).toBe(201);
  }
}

async function closeWithOtp(stall: BrowserContext, staff: BrowserContext, ticketId: string) {
  const otpResponse = await stall.request.get(`/api/tickets/${ticketId}/otp`);
  expect(otpResponse.status()).toBe(200);
  const body = await otpResponse.json() as { otp: string | null; expired?: boolean };
  expect(body.otp).toMatch(/^\d{6}$/);
  const stallVerify = await stall.request.post(`/api/tickets/${ticketId}/otp/verify`, { data: { otp: body.otp } });
  expect([403, 429].includes(stallVerify.status()), `stall verify status ${stallVerify.status()}`).toBe(true);
  if (stallVerify.status() === 403) {
    expect(String((await stallVerify.json()).message ?? '')).toMatch(/assigned staff|hall manager|Forbidden/i);
  }
  const closeResponse = await staff.request.post(`/api/tickets/${ticketId}/otp/verify`, { data: { otp: body.otp } });
  expect(closeResponse.status(), await closeResponse.text()).toBe(201);
}

test.describe.serial('isolated multi-role operational acceptance', () => {
  test.beforeAll(async () => {
    await expect.poll(async () => {
      try {
        const health = await fetch('http://localhost:4000/api/system/health');
        const loginPage = await fetch(`${baseURL}/login`);
        return health.ok && loginPage.ok;
      } catch {
        return false;
      }
    }, { timeout: 120_000 }).toBe(true);
    await prisma.$connect();
    await prepareFixture();
  });
  test.beforeEach(async () => clearOperationalData());
  test.afterAll(async () => {
    await destroyFixture();
    await prisma.$disconnect();
  });

  test('1 normal Electrical lifecycle is visible through verified closure', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const manager = await login(browser, emails.manager);
    const admin = await login(browser, emails.admin);
    const governance = await login(browser, emails.super, 'GOVERNANCE');
    const ticket = await createTicket(stall);
    expect(ticket.status).toBe('ASSIGNED');
    const staffPage = await staff.newPage();
    await staffPage.goto('/staff');
    await expect(staffPage.getByText(ticket.publicNo)).toBeVisible();
    await expect(staffPage.getByRole('button', { name: 'Accept task' }).first()).toBeVisible();
    await advanceToOtp(staff, ticket.id);
    const afterRequest = await (await staff.request.get(`/api/tickets/${ticket.id}`)).json() as { status: string; completionRequestedAt: string | null };
    expect(afterRequest.status).toBe('AWAITING_OTP');
    expect(afterRequest.completionRequestedAt).toBeTruthy();
    const stallPage = await stall.newPage();
    await stallPage.goto('/stall');
    await expect(stallPage.getByText(ticket.publicNo)).toBeVisible();
    await expect(stallPage.getByText('Waiting for completion verification')).toBeVisible();
    const showCode = stallPage.getByRole('button', { name: /Show completion code|Loading code/ });
    if (await showCode.isVisible().catch(() => false)) {
      await expect.poll(async () => showCode.isEnabled(), { timeout: 15_000 }).toBe(true);
      await showCode.click();
    }
    await expect(stallPage.getByText('Completion code', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(stallPage.locator('.otp-digits')).toBeVisible();
    const staffAwait = await staff.newPage();
    await staffAwait.goto('/staff');
    await expect(staffAwait.getByText("Waiting for stall's code")).toBeVisible();
    await expect(staffAwait.getByRole('button', { name: 'Verify code' })).toBeVisible();
    await expect(staffAwait.locator('.otp-digits')).toHaveCount(0);
    await closeWithOtp(stall, staff, ticket.id);
    const detail = await admin.request.get(`/api/tickets/${ticket.id}`);
    const closed = await detail.json() as { status: string; closedAt: string | null; firstAcceptedAt: string | null; firstStartedAt: string | null };
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).toBeTruthy();
    expect(closed.firstAcceptedAt).toBeTruthy();
    expect(closed.firstStartedAt).toBeTruthy();
    const timing = await (await manager.request.get('/api/management/timing')).json() as Array<{ id: string; firstAssignedAt: string | null; closedAt: string | null }>;
    const timingRow = timing.find((row) => row.id === ticket.id);
    expect(timingRow?.firstAssignedAt).toBeTruthy();
    expect(timingRow?.closedAt).toBeTruthy();
    const staffMe = await (await staff.request.get('/api/workforce/me')).json() as { activeCount: number; completedToday: number };
    expect(staffMe.activeCount).toBe(0);
    expect(staffMe.completedToday).toBeGreaterThanOrEqual(1);
    const history = await (await staff.request.get('/api/tickets?view=closed&limit=10')).json() as { items: Array<{ id: string }> };
    expect(history.items.some((item) => item.id === ticket.id)).toBe(true);
    expect((await manager.request.get(`/api/tickets/${ticket.id}`)).status()).toBe(200);
    expect((await governance.request.get(`/api/tickets/${ticket.id}`)).status()).toBe(200);
    expect(await prisma.ticketEvent.count({ where: { ticketId: ticket.id } })).toBeGreaterThanOrEqual(6);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: ticket.id } })).toBeGreaterThanOrEqual(5);
    await Promise.all([stall.close(), staff.close(), manager.close(), admin.close(), governance.close()]);
  });

  test('2 Hall Manager request routes to the scoped Hall Manager', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const manager = await login(browser, emails.manager);
    const ticket = await createTicket(stall, 'HALL_MANAGER', 'General');
    expect(ticket.status).toBe('ASSIGNED');
    const active = await manager.request.get('/api/tickets?view=active');
    expect((await active.json()).items.some((item: { id: string }) => item.id === ticket.id)).toBe(true);
    await advanceToOtp(manager, ticket.id);
    await closeWithOtp(stall, manager, ticket.id);
    await Promise.all([stall.close(), manager.close()]);
  });

  test('2b Hall Manager can verify stall OTP for an assigned staff ticket', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const manager = await login(browser, emails.manager);
    const ticket = await createTicket(stall);
    expect(ticket.status).toBe('ASSIGNED');
    await advanceToOtp(staff, ticket.id);
    const otpResponse = await stall.request.get(`/api/tickets/${ticket.id}/otp`);
    expect(otpResponse.status()).toBe(200);
    const { otp } = await otpResponse.json() as { otp: string };
    expect(otp).toMatch(/^\d{6}$/);
    const managerPresent = await manager.request.get(`/api/tickets/${ticket.id}/otp`);
    expect(managerPresent.status()).toBe(403);
    const verified = await manager.request.post(`/api/tickets/${ticket.id}/otp/verify`, { data: { otp } });
    expect(verified.status(), await verified.text()).toBe(201);
    expect((await verified.json()).status).toBe('CLOSED');
    const event = await prisma.ticketEvent.findFirst({
      where: { ticketId: ticket.id, eventType: 'OTP_VERIFIED' },
      orderBy: { createdAt: 'desc' },
    });
    expect((event?.metadata as { enteredBy?: string } | null)?.enteredBy).toBe('HALL_MANAGER');
    await Promise.all([stall.close(), staff.close(), manager.close()]);
  });

  test('3 compatible pool queue remains FIFO when capacity is released', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const first = await createTicket(stall);
    const second = await createTicket(stall);
    const third = await createTicket(stall);
    expect(first.status).toBe('ASSIGNED');
    expect(second.status).toBe('QUEUED');
    expect(third.status).toBe('QUEUED');
    await advanceToOtp(staff, first.id);
    await closeWithOtp(stall, staff, first.id);
    await expect.poll(async () => {
      const response = await stall.request.get(`/api/tickets/${second.id}`);
      return (await response.json()).status;
    }).toBe('ASSIGNED');
    expect((await (await stall.request.get(`/api/tickets/${third.id}`)).json()).status).toBe('QUEUED');
    await Promise.all([stall.close(), staff.close()]);
  });

  test('4 snooze deadline is processed once by the worker', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const ticket = await createTicket(stall);
    expect((await staff.request.post(`/api/tickets/${ticket.id}/snooze`)).status()).toBe(201);
    await prisma.assignment.updateMany({ where: { ticketId: ticket.id }, data: { snoozedUntil: new Date(Date.now() - 1000) } });
    await expect.poll(() => prisma.ticketEvent.count({ where: { ticketId: ticket.id, eventType: 'ASSIGNMENT_RESPONSE_OVERDUE' } }), { timeout: 15_000 }).toBe(1);
    await Promise.all([stall.close(), staff.close()]);
  });

  test('5 complaint and reopen preserve one ticket identity', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const manager = await login(browser, emails.manager);
    const ticket = await createTicket(stall);
    await advanceToOtp(staff, ticket.id);
    const complaint = await stall.request.post(`/api/tickets/${ticket.id}/complaints`, {
      data: { reasonCode: 'WORK_INCOMPLETE', comment: 'Still unresolved', idempotencyKey: randomUUID() },
    });
    expect((await complaint.json()).status).toBe('COMPLAINT_RAISED');
    const reopened = await manager.request.post(`/api/tickets/${ticket.id}/transition`, { data: { to: 'REOPENED', reason: 'Complaint requires another cycle' } });
    const reopenedTicket = await reopened.json();
    expect(reopenedTicket.id).toBe(ticket.id);
    expect(reopenedTicket.reopenCount).toBe(1);
    await Promise.all([stall.close(), staff.close(), manager.close()]);
  });

  test('6 manipulated stall scope and object IDs are rejected', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const admin = await login(browser, emails.admin);
    const otherTicket = await createTicket(admin, 'ELECTRICAL', 'Lighting', ids.otherStall);
    expect((await stall.request.get(`/api/tickets?stallId=${ids.otherStall}`)).status()).toBe(403);
    expect((await stall.request.get(`/api/tickets/${otherTicket.id}`)).status()).toBe(403);
    await Promise.all([stall.close(), admin.close()]);
  });

  test('7 expired session clears the protected page and redirects', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const ticket = await createTicket(stall);
    const page = await stall.newPage();
    await page.goto('/stall');
    await expect(page.getByText(ticket.publicNo)).toBeVisible();
    await prisma.session.updateMany({ where: { userId: ids.stallUser }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(ticket.publicNo)).toHaveCount(0);
    await stall.close();
  });

  test('8 cross-role realtime reconciles a newly created ticket', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const admin = await login(browser, emails.admin);
    const adminPage = await admin.newPage();
    await adminPage.goto('/admin');
    await admin.setOffline(true);
    const ticket = await createTicket(stall);
    await admin.setOffline(false);
    await adminPage.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(adminPage.getByText(ticket.publicNo).first()).toBeVisible({ timeout: 15_000 });
    await Promise.all([stall.close(), admin.close()]);
  });

  test('9 scoped management APIs return live contracts', async ({ browser }) => {
    const manager = await login(browser, emails.manager);
    const admin = await login(browser, emails.admin);
    for (const path of ['/api/management/metrics', '/api/management/timing', '/api/workforce']) {
      expect((await manager.request.get(path)).status()).toBe(200);
    }
    for (const path of ['/api/management/metrics', '/api/management/timing', '/api/management/exports', '/api/management/audit']) {
      expect((await admin.request.get(path)).status()).toBe(200);
    }
    const exportResponse = await admin.request.post('/api/management/exports', {
      data: { format: 'CSV', filters: { eventId: ids.event }, columns: ['ticket_number', 'status', 'created_at'] },
    });
    expect(exportResponse.status()).toBe(201);
    const exportJob = await exportResponse.json() as { id: string };
    await expect.poll(async () => {
      const jobs = await (await admin.request.get('/api/management/exports')).json() as Array<{ id: string; status: string }>;
      return jobs.find((job) => job.id === exportJob.id)?.status;
    }, { timeout: 15_000 }).toBe('READY');
    expect((await admin.request.get(`/api/management/exports/${exportJob.id}/download`)).status()).toBe(200);
    await Promise.all([manager.close(), admin.close()]);
  });

  test('10 SuperAdmin governance login is isolated and functional', async ({ page }) => {
    await page.goto('/governance-access');
    await page.getByLabel('SuperAdmin ID').fill(emails.super);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Enter governance workspace' }).click();
    await expect(page).toHaveURL(/\/super-admin/);
    await expect(page.getByText('Organization governance')).toBeVisible();
    expect((await page.request.get('/api/management/portfolio')).status()).toBe(200);
  });

  test('11 Hall Manager creates House Help worker pending Admin approval', async ({ browser }) => {
    const manager = await login(browser, emails.manager);
    const admin = await login(browser, emails.admin);
    const create = await manager.request.post('/api/workforce/people', {
      data: {
        name: 'Test House Help',
        email: `${runKey}.created-house@eveops.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        hallId: ids.hall,
        serviceCategory: 'HOUSE_HELP',
        serviceSubtype: 'General',
        capacity: 1,
        employeeCode: 'HELP-E2E-NEW',
      },
    });
    expect(create.status()).toBe(403);
    expect(String((await create.json()).message)).toMatch(/Admin can assign public person IDs/i);
    const createOk = await manager.request.post('/api/workforce/people', {
      data: {
        name: 'Test House Help',
        email: `${runKey}.created-house@eveops.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        hallId: ids.hall,
        serviceCategory: 'HOUSE_HELP',
        serviceSubtype: 'General',
        capacity: 1,
      },
    });
    expect(createOk.status(), await createOk.text()).toBe(201);
    const person = await createOk.json() as { id: string; employeeCode: string | null; approvalStatus: string };
    expect(person.employeeCode).toBeNull();
    expect(person.approvalStatus).toBe('PENDING_APPROVAL');
    const forbidAdmin = await manager.request.post('/api/workforce/people', {
      data: {
        name: 'Bad Admin',
        email: `${runKey}.bad-admin@eveops.test`,
        password,
        role: 'ADMIN',
        eventId: ids.event,
      },
    });
    expect(forbidAdmin.status()).toBe(403);
    const pendingLogin = await manager.request.post('/api/auth/login', {
      data: { email: `${runKey}.created-house@eveops.test`, password, portal: 'OPERATIONS' },
    });
    expect(pendingLogin.status()).toBe(403);
    const pending = await admin.request.get('/api/workforce/pending');
    expect(pending.status()).toBe(200);
    expect((await pending.json() as Array<{ id: string }>).some((item) => item.id === person.id)).toBe(true);
    const approve = await admin.request.post(`/api/workforce/people/${person.id}/approve`);
    expect(approve.status(), await approve.text()).toBe(201);
    const approved = await approve.json() as { employeeCode: string };
    expect(approved.employeeCode).toMatch(/^HELP-\d{4}$/);
    const deactivate = await manager.request.patch(`/api/workforce/people/${person.id}`, { data: { status: 'DISABLED' } });
    expect(deactivate.status()).toBe(200);
    const loginAttempt = await manager.request.post('/api/auth/login', {
      data: { email: `${runKey}.created-house@eveops.test`, password, portal: 'OPERATIONS' },
    });
    expect(loginAttempt.status()).toBe(401);
    await Promise.all([manager.close(), admin.close()]);
  });

  test('11b Admin create Staff requires hall and succeeds with hall', async ({ browser }) => {
    const admin = await login(browser, emails.admin);
    const missingHall = await admin.request.post('/api/workforce/people', {
      data: {
        name: 'No Hall Staff',
        email: `${runKey}.no-hall@eveops.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        serviceCategory: 'ELECTRICAL',
        serviceSubtype: 'Lighting',
        capacity: 1,
      },
    });
    expect(missingHall.status()).toBe(400);
    expect(String((await missingHall.json()).message)).toMatch(/hall/i);

    const adminPage = await admin.newPage();
    await adminPage.goto('/admin');
    await adminPage.getByRole('button', { name: 'Workforce' }).click();
    await adminPage.getByRole('button', { name: 'Add person' }).click();
    await expect(adminPage.getByLabel(/^Hall/)).toBeVisible();
    await adminPage.getByLabel(/^Name/).fill('Admin Created Electrician');
    await adminPage.getByLabel(/Login email/).fill(`${runKey}.admin-created@eveops.test`);
    await adminPage.getByLabel(/Temporary password/).fill(password);
    await adminPage.getByLabel(/^Hall/).selectOption(ids.hall);
    await adminPage.getByLabel(/Service category/).selectOption('ELECTRICAL');
    await adminPage.getByLabel(/Service subtype/).selectOption('Lighting');
    await adminPage.getByRole('button', { name: 'Create account' }).click();
    await expect.poll(async () => {
      const created = await prisma.user.findUnique({ where: { email: `${runKey}.admin-created@eveops.test` } });
      return created?.approvalStatus === 'APPROVED' && created.mustChangePassword === true;
    }, { timeout: 15_000 }).toBe(true);
    await expect(adminPage.getByText(/Temporary password must be changed on first sign-in|Created Admin Created Electrician/i)).toBeVisible({ timeout: 10_000 });

    const created = await prisma.user.findUnique({ where: { email: `${runKey}.admin-created@eveops.test` } });
    expect(created?.approvalStatus).toBe('APPROVED');
    expect(created?.mustChangePassword).toBe(true);
    const scope = await prisma.userScope.findFirst({ where: { userId: created!.id } });
    expect(scope?.hallId).toBe(ids.hall);
    await admin.close();
  });

  test('12 House Help OTP flow closes and frees capacity', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const house = await login(browser, emails.houseStaff);
    const manager = await login(browser, emails.manager);
    const ticket = await createTicket(stall, 'HOUSE_HELP', 'General');
    expect(ticket.status).toBe('ASSIGNED');
    await advanceToOtp(house, ticket.id);
    const wrong = await house.request.post(`/api/tickets/${ticket.id}/otp/verify`, { data: { otp: '000000' } });
    expect(wrong.status()).toBe(400);
    const stillOpen = await (await stall.request.get(`/api/tickets/${ticket.id}`)).json() as { status: string };
    expect(stillOpen.status).toBe('AWAITING_OTP');
    await closeWithOtp(stall, house, ticket.id);
    const closed = await (await stall.request.get(`/api/tickets/${ticket.id}`)).json() as { status: string };
    expect(closed.status).toBe('CLOSED');
    const duplicate = await house.request.post(`/api/tickets/${ticket.id}/otp/verify`, { data: { otp: '123456' } });
    expect([200, 201].includes(duplicate.status()), `duplicate OTP status ${duplicate.status()} ${await duplicate.text()}`).toBe(true);
    expect((await duplicate.json()).status).toBe('CLOSED');
    const me = await (await house.request.get('/api/workforce/me')).json() as { activeCount: number };
    expect(me.activeCount).toBe(0);
    expect((await manager.request.get('/api/management/exceptions')).status()).toBe(200);
    await Promise.all([stall.close(), house.close(), manager.close()]);
  });

  test('13 Hall Manager ping and reassign preserve history', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const house = await login(browser, emails.houseStaff);
    const manager = await login(browser, emails.manager);
    const admin = await login(browser, emails.admin);
    await house.request.patch('/api/workforce/availability', { data: { value: 'ON_DUTY' } });
    const ticket = await createTicket(stall);
    expect(ticket.status).toBe('ASSIGNED');
    const ping = await manager.request.post(`/api/tickets/${ticket.id}/ping`, { data: { message: 'Reach the stall ASAP' } });
    expect(ping.status(), await ping.text()).toBe(201);
    const notifications = await prisma.notification.count({ where: { ticketId: ticket.id, type: 'STAFF_PINGED' } });
    expect(notifications).toBeGreaterThanOrEqual(1);
    // Reassign electrical ticket only to electrical-compatible staff — create second electrician
    const second = await manager.request.post('/api/workforce/people', {
      data: {
        name: 'Second Electrician',
        email: `${runKey}.elec2@eveops.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        hallId: ids.hall,
        serviceCategory: 'ELECTRICAL',
        serviceSubtype: 'Lighting',
        capacity: 1,
      },
    });
    expect(second.status(), await second.text()).toBe(201);
    const secondPerson = await second.json() as { id: string };
    const approveSecond = await admin.request.post(`/api/workforce/people/${secondPerson.id}/approve`);
    expect(approveSecond.status(), await approveSecond.text()).toBe(201);
    await prisma.workforceMembership.updateMany({ where: { userId: secondPerson.id }, data: { availability: 'ON_DUTY' } });
    const reassign = await manager.request.patch(`/api/workforce/tickets/${ticket.id}/reassign`, {
      data: { staffId: secondPerson.id, reason: 'Original staff delayed' },
    });
    expect(reassign.status(), await reassign.text()).toBe(200);
    const assignments = await prisma.assignment.findMany({ where: { ticketId: ticket.id }, orderBy: { assignedAt: 'asc' } });
    expect(assignments.length).toBeGreaterThanOrEqual(2);
    expect(assignments.some((item) => item.status === 'RELEASED')).toBe(true);
    expect(assignments.some((item) => item.staffId === secondPerson.id && ['ACTIVE', 'ACCEPTED'].includes(item.status))).toBe(true);
    await manager.request.patch(`/api/workforce/people/${secondPerson.id}`, { data: { status: 'DISABLED' } });
    await Promise.all([stall.close(), staff.close(), house.close(), manager.close(), admin.close()]);
  });

  test('14 Staff availability pause blocks new routing but keeps active work', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const first = await createTicket(stall);
    expect(first.status).toBe('ASSIGNED');
    const firstAssignment = await prisma.assignment.findFirst({
      where: { ticketId: first.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    });
    expect(firstAssignment?.staffId).toBe(ids.staffUser);
    const paused = await staff.request.patch('/api/workforce/availability', { data: { value: 'PAUSED' } });
    expect(paused.status()).toBe(200);
    const second = await createTicket(stall);
    expect(second.status).toBe('QUEUED');
    const active = await (await staff.request.get('/api/tickets?view=active')).json() as { items: Array<{ id: string }> };
    expect(active.items.some((item) => item.id === first.id)).toBe(true);
    const onDuty = await staff.request.patch('/api/workforce/availability', { data: { value: 'ON_DUTY' } });
    expect(onDuty.status()).toBe(200);
    await advanceToOtp(staff, first.id);
    await closeWithOtp(stall, staff, first.id);
    await expect.poll(async () => (await (await stall.request.get(`/api/tickets/${second.id}`)).json()).status).toBe('ASSIGNED');
    await Promise.all([stall.close(), staff.close()]);
  });

  test('15 expired OTP rejects staff verify until stall regenerates', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const ticket = await createTicket(stall);
    await advanceToOtp(staff, ticket.id);
    const otpResponse = await stall.request.get(`/api/tickets/${ticket.id}/otp`);
    const { otp } = await otpResponse.json() as { otp: string };
    await prisma.otpChallenge.updateMany({
      where: { ticketId: ticket.id, verifiedAt: null, invalidatedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 60_000) },
    });
    const expired = await staff.request.post(`/api/tickets/${ticket.id}/otp/verify`, { data: { otp } });
    expect(expired.status()).toBe(400);
    expect(String((await expired.json()).message)).toMatch(/expired/i);
    const regenerate = await stall.request.post(`/api/tickets/${ticket.id}/otp/regenerate`);
    expect(regenerate.status()).toBe(201);
    await closeWithOtp(stall, staff, ticket.id);
    expect((await (await stall.request.get(`/api/tickets/${ticket.id}`)).json()).status).toBe('CLOSED');
    await Promise.all([stall.close(), staff.close()]);
  });

  test('16 pending Hall Manager staff is not route-eligible until Admin approves', async ({ browser }) => {
    const stall = await login(browser, emails.stall);
    const manager = await login(browser, emails.manager);
    const admin = await login(browser, emails.admin);
    await prisma.workforceMembership.updateMany({
      where: { poolId: ids.electricalPool },
      data: { availability: 'OFF_DUTY' },
    });
    const create = await manager.request.post('/api/workforce/people', {
      data: {
        name: 'Pending Route Electrician',
        email: `${runKey}.pending-route@eveops.test`,
        password,
        role: 'STAFF',
        eventId: ids.event,
        hallId: ids.hall,
        serviceCategory: 'ELECTRICAL',
        serviceSubtype: 'Lighting',
        capacity: 1,
      },
    });
    expect(create.status(), await create.text()).toBe(201);
    const person = await create.json() as { id: string; employeeCode: string | null };
    expect(person.employeeCode).toBeNull();
    await prisma.workforceMembership.updateMany({ where: { userId: person.id }, data: { availability: 'ON_DUTY' } });
    const ticket = await createTicket(stall);
    expect(ticket.status).toBe('QUEUED');
    const approve = await admin.request.post(`/api/workforce/people/${person.id}/approve`);
    expect(approve.status()).toBe(201);
    expect((await approve.json() as { employeeCode: string }).employeeCode).toMatch(/^ELEC-\d{4}$/);
    const pendingStaff = await login(browser, `${runKey}.pending-route@eveops.test`);
    const blocked = await pendingStaff.request.patch('/api/workforce/availability', { data: { value: 'ON_DUTY' } });
    expect(blocked.status()).toBe(403);
    expect(String((await blocked.json()).message)).toMatch(/password change/i);
    const rotated = await pendingStaff.request.post('/api/auth/change-password', {
      data: { currentPassword: password, newPassword: `${password}Rot1` },
    });
    expect(rotated.status(), await rotated.text()).toBe(201);
    const duty = await pendingStaff.request.patch('/api/workforce/availability', { data: { value: 'ON_DUTY' } });
    expect(duty.status(), await duty.text()).toBe(200);
    await expect.poll(async () => (await (await stall.request.get(`/api/tickets/${ticket.id}`)).json()).status).toBe('ASSIGNED');
    const activeAssignment = await prisma.assignment.findFirst({
      where: { ticketId: ticket.id, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    });
    expect(activeAssignment?.staffId).toBe(person.id);
    await Promise.all([stall.close(), manager.close(), admin.close(), pendingStaff.close()]);
  });

  test('17 service priority orders the queue and registrations stay on their own page', async ({ browser }) => {
    await prisma.stall.update({ where: { id: ids.otherStall }, data: { servicePriority: 'HIGH' } });
    const stall = await login(browser, emails.stall);
    const staff = await login(browser, emails.staff);
    const admin = await login(browser, emails.admin);
    const first = await createTicket(stall);
    expect(first.status).toBe('ASSIGNED');
    const high = await createTicket(admin, 'ELECTRICAL', 'Lighting', ids.otherStall);
    const medium = await createTicket(stall);
    expect(high.status).toBe('QUEUED');
    expect(medium.status).toBe('QUEUED');
    expect((await (await admin.request.get(`/api/tickets/${high.id}`)).json()).servicePriority).toBe('HIGH');
    await advanceToOtp(staff, first.id);
    await closeWithOtp(stall, staff, first.id);
    await expect.poll(async () => (await (await admin.request.get(`/api/tickets/${high.id}`)).json()).status).toBe('ASSIGNED');
    expect((await (await admin.request.get(`/api/tickets/${medium.id}`)).json()).status).toBe('QUEUED');

    const registrations = await admin.newPage();
    await registrations.goto('/admin/registrations');
    await expect(registrations.getByRole('heading', { name: 'Stall registrations' })).toBeVisible();
    await expect(registrations.getByRole('heading', { name: 'Exhibitor accounts' })).toBeVisible();
    await expect(registrations.getByRole('heading', { name: 'Staff' })).toBeVisible();
    await expect(registrations.getByRole('heading', { name: 'Hall managers' })).toBeVisible();
    const blocked = await admin.request.post(`/api/management/registrations/${ids.stall}/archive`, {
      data: { reason: 'Open work should block archive' },
    });
    expect(blocked.status()).toBe(409);

    const task = await staff.newPage();
    await task.goto(`/staff/task/${high.id}`);
    await expect(task.getByRole('button', { name: 'Accept task' })).toBeVisible();
    await Promise.all([stall.close(), staff.close(), admin.close()]);
  });
});

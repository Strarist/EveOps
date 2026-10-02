import { expect, test, type Browser, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const password = process.env.REGRESSION_FIXTURE_PASSWORD ?? '';
const apiOrigin = process.env.API_URL?.replace(/\/api$/, '') ?? 'http://localhost:4100';
const webOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:3110';
const prisma = new PrismaClient();

test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (password.length < 12) throw new Error('Set REGRESSION_FIXTURE_PASSWORD before browser regression. Do not commit it.');
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: 'phase2-old-' } } });
  await prisma.$disconnect();
});

test('staff and manager setup covers granted, dismissed, denied, and unsupported', async ({ browser }) => {
  test.setTimeout(180_000);
  await checkSetup(browser, {
    email: 'regression.elec.h1.1@volume.lab',
    heading: 'Electrician H1.1',
    path: '/staff',
    width: 390,
    mode: 'granted',
  });
  await checkSetup(browser, {
    email: 'regression.manager.h1@volume.lab',
    heading: 'Hall 1 operations',
    path: '/hall-manager',
    width: 1280,
    mode: 'granted',
  });
  await checkSetup(browser, {
    email: 'regression.help.h1.1@volume.lab',
    heading: 'House help H1.1',
    path: '/staff',
    width: 390,
    mode: 'default',
  });
  await checkSetup(browser, {
    email: 'regression.elec.h4.1@volume.lab',
    heading: 'Electrician H4.1',
    path: '/staff',
    width: 390,
    mode: 'denied',
  });
  await checkSetup(browser, {
    email: 'regression.manager.h4@volume.lab',
    heading: 'Hall 4 operations',
    path: '/hall-manager',
    width: 1280,
    mode: 'unsupported',
  });
  await checkSetup(browser, {
    email: 'regression.help.h4.1@volume.lab',
    heading: 'House help H4.1',
    path: '/staff',
    width: 390,
    mode: 'suspended',
  });
});

test('logout, account switch, session expiry, and legacy sound preferences stay isolated', async ({ browser }) => {
  test.setTimeout(120_000);
  const first = await openAccount(browser, 'regression.elec.h2.1@volume.lab', '/staff', {
    init: () => {
      window.localStorage.setItem('eveops-sound-off', '1');
      window.localStorage.setItem('eveops-sound-choice', 'classic');
    },
  });
  await expect(first.page.getByRole('heading', { name: 'Electrician H2.1' })).toBeVisible();
  await expect.poll(async () => first.page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith('eveops-sound')))).toEqual([]);
  await first.page.getByRole('button', { name: 'Enable work alerts and continue' }).click();
  await expect(first.page.getByRole('button', { name: 'Enable work alerts and continue' })).toHaveCount(0);
  await first.page.getByRole('button', { name: 'Sign out' }).click();
  await first.page.waitForURL(/\/login/);
  const switched = await mintSession((await prisma.user.findUniqueOrThrow({ where: { email: 'regression.manager.h2@volume.lab' } })).id);
  await first.context.addCookies([{ name: 'eveops_session', value: switched, url: webOrigin }]);
  await first.page.goto('/hall-manager');
  await expect(first.page.getByRole('heading', { name: 'Hall 2 operations' })).toBeVisible();
  await expect(first.page.getByRole('button', { name: 'Enable work alerts and continue' })).toBeVisible();
  await expect(first.page.getByRole('status', { name: 'Work alert' })).toHaveCount(0);
  await first.context.close();

  const expiring = await openAccount(browser, 'regression.help.h2.1@volume.lab', '/staff');
  await expect(expiring.page.getByRole('heading', { name: 'House help H2.1' })).toBeVisible();
  await prisma.session.deleteMany({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: 'regression.help.h2.1@volume.lab' } })).id } });
  await expiring.page.reload();
  await expiring.page.waitForURL(/\/login/);
  await expiring.context.close();
});

test('a burst rings one alert at a time, and another tab takes over when the player closes', async ({ browser }) => {
  test.setTimeout(180_000);
  const electrician = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.elec.h4.1@volume.lab' } });
  const helper = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.help.h4.2@volume.lab' } });
  const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.manager.h4@volume.lab' } });
  const ticketIds: string[] = [];
  await prisma.workforceMembership.updateMany({
    where: { userId: { in: [electrician.id, helper.id] } },
    data: { availability: 'ON_DUTY', capacity: 4 },
  });
  const oldKey = `phase2-old-${Date.now().toString(36)}`;
  await prisma.notification.create({
    data: {
      eventId: 'regression-event',
      recipientId: electrician.id,
      type: 'TICKET_CREATED',
      dedupeKey: oldKey,
      sentAt: new Date(Date.now() - 60 * 60 * 1000),
      payload: {
        audience: 'team',
        tone: 'operational',
        actionable: true,
        summary: 'Earlier request · Stall H4-01 · House Help',
        stallCode: 'H4-01',
      },
    },
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, permissions: ['notifications'] });
  await context.addInitScript(installAudioProbe);
  const page = await context.newPage();
  const other = await context.newPage();
  try {
    await enter(page, electrician.id, '/staff');
    await enter(other, electrician.id, '/staff');
    await expect(page.getByRole('heading', { name: 'Electrician H4.1' })).toBeVisible();
    await expect(other.getByRole('heading', { name: 'Electrician H4.1' })).toBeVisible();
    await page.getByRole('button', { name: 'Enable work alerts and continue' }).click();
    await other.getByRole('button', { name: 'Enable work alerts and continue' }).click();
    await page.getByRole('button', { name: /Alerts ·/ }).click();
    await expect(page.getByRole('button', { name: 'Earlier request · Stall H4-01 · House Help' })).toBeVisible();
    expect(await toneCount(page)).toBe(0);
    expect(await toneCount(other)).toBe(0);
    const first = await raiseHouseHelp(`phase2-burst-a-${Date.now().toString(36)}`);
    const second = await raiseHouseHelp(`phase2-burst-b-${Date.now().toString(36)}`);
    ticketIds.push(first.id, second.id);
    await expect(page.getByRole('status', { name: 'Work alert' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /Alerts ·/ })).toContainText(/[2-9]/);
    await page.waitForTimeout(1600);
    const tones = await page.evaluate(() => (window as Window & { __tones?: Array<{ at: number; frequency: number; peak: number }> }).__tones ?? []);
    const otherTones = await other.evaluate(() => (window as Window & { __tones?: Array<{ at: number; frequency: number; peak: number }> }).__tones ?? []);
    expect(tones.length + otherTones.length).toBeGreaterThan(0);
    expect(Math.min(tones.length, otherTones.length)).toBe(0);
    expect(overlapping(tones.map((tone) => tone.at))).toBe(false);
    expect(tones.concat(otherTones).some((tone) => tone.frequency === 520 || tone.frequency === 780)).toBe(true);
    expect(new Set(tones.concat(otherTones).map((tone) => tone.peak)).size).toBeGreaterThan(0);
    expect(Math.max(...tones.concat(otherTones).map((tone) => tone.peak))).toBeGreaterThanOrEqual(0.1);
    const player = tones.length ? page : other;
    const standby = tones.length ? other : page;
    await expect(player.getByRole('status', { name: 'Work alert' })).toContainText('New request · Stall H4-01 · House Help');
    await expect(player.getByRole('status', { name: 'Work alert' })).not.toContainText('Your new task');
    const notice = await prisma.notification.findFirstOrThrow({
      where: { recipientId: electrician.id, ticketId: first.id, type: 'TICKET_CREATED' },
      select: { id: true },
    });
    const summary = await context.newPage();
    await enter(summary, electrician.id, `/staff/alerts/${notice.id}`);
    await expect(summary.getByRole('heading', { name: 'Team alert' })).toBeVisible();
    await expect(summary.getByText('This is a team update. It is not assigned to you, and it does not ask you to accept the task.')).toBeVisible();
    await expect(summary.getByRole('button', { name: 'Accept task' })).toHaveCount(0);
    const detail = await summary.evaluate(async (ticketId) => {
      const response = await fetch('/api/tickets/' + ticketId, { credentials: 'include' });
      return response.status;
    }, first.id);
    expect(detail).toBeGreaterThanOrEqual(400);
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: first.id }, select: { status: true } });
    await player.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(player.getByRole('status', { name: 'Work alert' })).toBeVisible();
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: first.id }, select: { status: true } });
    expect(after.status).toBe(before.status);

    const managerContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['notifications'] });
    const managerPage = await managerContext.newPage();
    await enter(managerPage, manager.id, '/hall-manager');
    await managerPage.getByRole('button', { name: 'Enable work alerts and continue' }).click();
    await expect(managerPage.getByRole('button', { name: /Alerts ·/ })).not.toHaveText('Alerts · 0', { timeout: 20_000 });
    await managerContext.close();

    await player.close();
    await expect.poll(async () => toneCount(standby), { timeout: 20_000 }).toBeGreaterThan(0);
  } finally {
    await context.close().catch(() => undefined);
    for (const id of ticketIds) await removeTicket(id);
    await prisma.notification.deleteMany({ where: { dedupeKey: oldKey } });
    await prisma.workforceMembership.updateMany({ where: { userId: electrician.id }, data: { availability: 'ON_DUTY', capacity: 1 } });
    await prisma.workforceMembership.updateMany({ where: { userId: helper.id }, data: { availability: 'ON_DUTY', capacity: 1 } });
  }
});

test('reassignment and closure stop the obsolete ring without silencing another recipient', async ({ browser }) => {
  test.setTimeout(180_000);
  const electrician = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.elec.h3.2@volume.lab' } });
  const standby = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.elec.h3.1@volume.lab' } });
  const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.manager.h3@volume.lab' } });
  const ticketIds: string[] = [];
  await prisma.workforceMembership.updateMany({ where: { userId: electrician.id }, data: { availability: 'ON_DUTY', capacity: 4 } });
  await prisma.workforceMembership.updateMany({ where: { userId: standby.id }, data: { availability: 'OFF_DUTY', capacity: 1 } });
  const workerContext = await browser.newContext({ viewport: { width: 390, height: 800 }, permissions: ['notifications'] });
  const managerContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['notifications'] });
  await workerContext.addInitScript(installAudioProbe);
  const workerPage = await workerContext.newPage();
  const managerPage = await managerContext.newPage();
  try {
    await enter(workerPage, electrician.id, '/staff');
    await enter(managerPage, manager.id, '/hall-manager');
    await workerPage.getByRole('button', { name: 'Enable work alerts and continue' }).click();
    await managerPage.getByRole('button', { name: 'Enable work alerts and continue' }).click();
    const created = await raiseElectrical(`phase2-reassign-${Date.now().toString(36)}`);
    ticketIds.push(created.id);
    await expect(workerPage.getByRole('status', { name: 'Work alert' })).toContainText('Your new task', { timeout: 20_000 });
    const managerCookie = `eveops_session=${await mintSession(manager.id)}`;
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'regression.admin@volume.lab' } });
    const adminCookie = `eveops_session=${await mintSession(admin.id)}`;
    await prisma.workforceMembership.updateMany({ where: { userId: standby.id }, data: { availability: 'ON_DUTY', capacity: 4 } });
    const moved = await fetch(`${apiOrigin}/api/workforce/tickets/${created.id}/reassign`, {
      method: 'PATCH',
      headers: { cookie: managerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staffId: standby.id, reason: 'Cover the hall while the first electrician is occupied' }),
    });
    expect(moved.status).toBe(200);
    await expect(workerPage.getByRole('status', { name: 'Work alert' }).filter({ hasText: 'Your new task' })).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(async () => managerPage.getByRole('button', { name: /Alerts ·/ }).innerText()).not.toBe('Alerts · 0');
    const managerBefore = await managerPage.getByRole('button', { name: /Alerts ·/ }).innerText();
    await workerPage.getByRole('button', { name: 'Acknowledge' }).click({ timeout: 5_000 }).catch(() => undefined);
    await expect(managerPage.getByRole('button', { name: /Alerts ·/ })).toHaveText(managerBefore);
    await closeThroughTheSupportedPath(created.id, adminCookie);
    await expect(workerPage.getByRole('status', { name: 'Work alert' })).toHaveCount(0, { timeout: 20_000 });

    const closed = await raiseHouseHelp(`phase2-close-${Date.now().toString(36)}`, 'regression.stall.h3-01@volume.lab');
    ticketIds.push(closed.id);
    await expect(workerPage.getByRole('status', { name: 'Work alert' })).toBeVisible({ timeout: 20_000 });
    await closeThroughTheSupportedPath(closed.id, adminCookie);
    await expect(workerPage.getByRole('status', { name: 'Work alert' })).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await workerContext.close().catch(() => undefined);
    await managerContext.close().catch(() => undefined);
    for (const id of ticketIds) await removeTicket(id);
    await prisma.workforceMembership.updateMany({ where: { userId: electrician.id }, data: { availability: 'ON_DUTY', capacity: 1 } });
    await prisma.workforceMembership.updateMany({ where: { userId: standby.id }, data: { availability: 'OFF_DUTY', capacity: 1 } });
  }
});

async function checkSetup(browser: Browser, journey: {
  email: string;
  heading: string;
  path: string;
  width: number;
  mode: 'granted' | 'default' | 'denied' | 'unsupported' | 'suspended';
}) {
  const context = await browser.newContext({
    viewport: { width: journey.width, height: 800 },
    permissions: journey.mode === 'granted' || journey.mode === 'suspended' ? ['notifications'] : [],
  });
  await context.addInitScript(installPermissionProbe, journey.mode === 'suspended' ? 'granted' : journey.mode);
  if (journey.mode === 'granted') await context.addInitScript(installAudioProbe);
  if (journey.mode === 'suspended') await context.addInitScript(installSuspendedAudio);
  const page = await context.newPage();
  const user = await prisma.user.findUniqueOrThrow({ where: { email: journey.email } });
  await enter(page, user.id, journey.path);
  await expect(page.getByRole('heading', { name: journey.heading })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn sound on' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Turn sound off' })).toHaveCount(0);
  const enable = page.getByRole('button', { name: 'Enable work alerts and continue' });
  await expect(enable).toBeVisible();
  await expect(page.getByText('Get alerts for new work and important updates.')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  if (journey.mode === 'granted' || journey.mode === 'denied') {
    await page.screenshot({ path: `test-results/phase2/setup-${journey.mode}-${journey.width}.png`, fullPage: true });
  }
  if (journey.mode === 'granted') {
    expect(await page.evaluate(() => (window as Window & { __constructed?: number }).__constructed ?? 0)).toBe(0);
  }
  await enable.click();
  await expect.poll(() => page.evaluate((id) => window.localStorage.getItem(`eveops-alert-setup:${id}`), user.id)).toBe('done');
  await expect(page.getByRole('button', { name: 'Enable work alerts and continue' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Checking…' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: journey.heading })).toBeVisible();
  if (journey.mode === 'granted') {
    expect(await requestCount(page)).toBe(0);
    await expect(page.getByText('Browser notifications are off.')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as Window & { __audioState?: string }).__audioState ?? 'missing')).toBe('running');
    expect(await page.evaluate(() => (window as Window & { __constructed?: number }).__constructed ?? 0)).toBeGreaterThan(0);
  }
  if (journey.mode === 'suspended') {
    expect(await requestCount(page)).toBe(0);
    await expect(page.getByText('Tap to hear work alerts.')).toBeVisible();
    await page.getByRole('button', { name: 'Hear work alerts' }).click();
    expect(await requestCount(page)).toBe(0);
    await expect(page.getByRole('heading', { name: journey.heading })).toBeVisible();
  }
  if (journey.mode === 'default') {
    expect(await requestCount(page)).toBe(1);
    await expect(page.getByText('Browser notifications were not allowed.')).toBeVisible();
  }
  if (journey.mode === 'denied') {
    expect(await requestCount(page)).toBe(0);
    await expect(page.getByText('Browser notifications are off.')).toBeVisible();
  }
  if (journey.mode === 'unsupported') {
    expect(await requestCount(page)).toBe(0);
    await expect(page.getByRole('heading', { name: journey.heading })).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole('heading', { name: journey.heading })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable work alerts and continue' })).toHaveCount(0);
  expect(await requestCount(page)).toBe(0);
  await context.close();
}

async function openAccount(browser: Browser, email: string, path: string, options?: { init?: () => void }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, permissions: ['notifications'] });
  if (options?.init) await context.addInitScript(options.init);
  const page = await context.newPage();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await enter(page, user.id, path);
  return { context, page };
}

async function enter(page: Page, userId: string, path: string) {
  const token = await mintSession(userId);
  await page.context().addCookies([{ name: 'eveops_session', value: token, url: webOrigin }]);
  await page.goto(path);
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
  return token;
}

async function raiseHouseHelp(key: string, email = 'regression.stall.h4-01@volume.lab') {
  return raiseTicket(key, email, 'HOUSE_HELP', 'General');
}

async function raiseElectrical(key: string) {
  return raiseTicket(key, 'regression.stall.h3-01@volume.lab', 'ELECTRICAL', 'Lighting');
}

async function raiseTicket(key: string, email: string, category: string, subtype: string) {
  const stall = await prisma.user.findUniqueOrThrow({ where: { email } });
  const cookie = `eveops_session=${await mintSession(stall.id)}`;
  const response = await fetch(`${apiOrigin}/api/tickets`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      category,
      subtype,
      description: 'Phase 2 alert check',
      priority: 'NORMAL',
      idempotencyKey: key,
    }),
  });
  if (response.status !== 201) throw new Error(`Ticket create failed with status ${response.status}`);
  return response.json() as Promise<{ id: string; status: string }>;
}

async function closeThroughTheSupportedPath(ticketId: string, adminCookie: string) {
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { status: true } });
  if (ticket.status === 'QUEUED' || ticket.status === 'NEW') {
    const cancelled = await fetch(`${apiOrigin}/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'CANCELLED', reason: 'The stall no longer needs this visit' }),
    });
    if (cancelled.status !== 201) throw new Error(`Cancellation failed with status ${cancelled.status}`);
    return;
  }
  const assignment = await prisma.assignment.findFirst({
    where: { ticketId, status: { in: ['ACTIVE', 'ACCEPTED'] } },
    select: { staffId: true },
  });
  if (!assignment) throw new Error('Assigned ticket has no current assignee');
  const staffCookie = `eveops_session=${await mintSession(assignment.staffId)}`;
  for (const to of ['ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP'] as const) {
    const current = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { status: true } });
    if (current.status === 'AWAITING_OTP' || current.status === 'CLOSED' || current.status === 'CANCELLED') break;
    if (current.status === to) continue;
    const moved = await fetch(`${apiOrigin}/api/tickets/${ticketId}/transition`, {
      method: 'POST',
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (moved.status !== 201) throw new Error(`Transition to ${to} failed with status ${moved.status}`);
  }
  const closed = await fetch(`${apiOrigin}/api/tickets/${ticketId}/override-close`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'The stall no longer needs this visit' }),
  });
  if (closed.status !== 201) throw new Error(`Emergency close failed with status ${closed.status}`);
}

async function removeTicket(id: string) {
  await prisma.notification.deleteMany({ where: { ticketId: id } });
  await prisma.complaint.deleteMany({ where: { ticketId: id } });
  await prisma.otpChallenge.deleteMany({ where: { ticketId: id } });
  await prisma.ticketEvent.deleteMany({ where: { ticketId: id } });
  await prisma.assignment.deleteMany({ where: { ticketId: id } });
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: id } });
  await prisma.ticket.delete({ where: { id } }).catch(() => undefined);
}

async function requestCount(page: Page) {
  return page.evaluate(() => (window as Window & { __notificationRequests?: number }).__notificationRequests ?? 0);
}

async function toneCount(page: Page) {
  return page.evaluate(() => (window as Window & { __tones?: unknown[] }).__tones?.length ?? 0);
}

function overlapping(times: number[]) {
  return times.some((time) => times.filter((other) => Math.abs(other - time) < 300).length > 2);
}

function installPermissionProbe(mode: 'granted' | 'default' | 'denied' | 'unsupported') {
  const target = window as Window & { __notificationRequests?: number };
  target.__notificationRequests = 0;
  if (mode === 'unsupported') {
    Object.defineProperty(window, 'Notification', { configurable: true, get: () => undefined });
    return;
  }
  if (mode === 'granted') {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    Notification.requestPermission = () => {
      target.__notificationRequests = (target.__notificationRequests ?? 0) + 1;
      return Promise.resolve('granted');
    };
    return;
  }
  const permission = mode === 'denied' ? 'denied' : 'default';
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
  Notification.requestPermission = () => {
    target.__notificationRequests = (target.__notificationRequests ?? 0) + 1;
    return Promise.resolve(permission);
  };
}

function installSuspendedAudio() {
  const Original = window.AudioContext;
  window.AudioContext = class extends Original {
    get state() {
      return 'suspended' as AudioContextState;
    }

    resume() {
      return Promise.resolve();
    }
  };
}

function installAudioProbe() {
  const target = window as Window & { __tones?: Array<{ at: number; frequency: number; peak: number }>; __audioState?: string; __peak?: number; __resumes?: number; __constructed?: number };
  target.__tones = [];
  target.__peak = 0;
  target.__resumes = 0;
  target.__constructed = 0;
  const Original = window.AudioContext;
  window.AudioContext = class extends Original {
    constructor() {
      super();
      target.__constructed = (target.__constructed ?? 0) + 1;
      target.__audioState = this.state;
      this.addEventListener('statechange', () => {
        target.__audioState = this.state;
      });
    }

    resume() {
      target.__resumes = (target.__resumes ?? 0) + 1;
      return super.resume();
    }

    createGain() {
      const gain = super.createGain();
      const ramp = gain.gain.exponentialRampToValueAtTime.bind(gain.gain);
      gain.gain.exponentialRampToValueAtTime = (value: number, time: number) => {
        if (value > (target.__peak ?? 0)) target.__peak = value;
        return ramp(value, time);
      };
      return gain;
    }

    createOscillator() {
      const oscillator = super.createOscillator();
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (when?: number) => {
        target.__tones?.push({
          at: Date.now(),
          frequency: oscillator.frequency.value,
          peak: target.__peak ?? 0,
        });
        return start(when);
      };
      return oscillator;
    }
  };
}

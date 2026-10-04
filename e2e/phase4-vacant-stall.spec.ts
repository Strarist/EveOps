import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const password = process.env.REGRESSION_FIXTURE_PASSWORD ?? '';
const prisma = new PrismaClient();

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test.beforeAll(() => {
  if (!/^[0-9]{4,7}$/.test(password)) throw new Error('Set REGRESSION_FIXTURE_PASSWORD to 4–7 digits before browser regression. Do not commit it.');
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('vacant stall login completes handoff, first password change, and stall scope', async ({ browser }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString(36);
  const email = `regression.vacant.${suffix}@volume.lab`;
  const personal = `Phase4${suffix}a1`;
  const admin = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await admin.newPage();
  await signIn(page, 'regression.admin@volume.lab', password, /\/admin/);
  await page.goto('/admin/registrations');
  await expect(page.getByRole('heading', { name: 'Stall registrations' })).toBeVisible();

  let stallCode = 'H4-VACANT';
  let article = page.locator('article').filter({ hasText: stallCode }).first();
  if (await article.getByText('No exhibitor login yet').count() === 0) {
    const zone = await prisma.zone.findFirstOrThrow({ where: { hall: { code: 'H4', eventId: 'regression-event' } } });
    stallCode = `P4-${suffix}`.slice(0, 18);
    const created = await page.request.post('/api/management/masters/stall', {
      data: {
        eventId: 'regression-event',
        zoneId: zone.id,
        stallCode,
        exhibitorName: 'Phase 4 vacant booth',
        servicePriority: 'LOW',
      },
    });
    expect(created.status()).toBe(201);
    await page.reload();
    article = page.locator('article').filter({ hasText: stallCode }).first();
  }
  await expect(article.getByText('No exhibitor login yet')).toBeVisible();
  await article.getByRole('button', { name: 'Create exhibitor login' }).click();
  await article.locator('input[name="loginName"]').fill('Phase 4 exhibitor');
  await article.locator('input[name="loginEmail"]').fill(email);
  await article.locator('form').getByRole('button', { name: 'Create exhibitor login' }).click();
  const handoff = page.getByRole('status', { name: 'Exhibitor login instructions' });
  await expect(handoff).toBeVisible();
  await expect(handoff.getByText(email)).toBeVisible();
  const initial = await handoff.locator('dd').nth(2).innerText();
  expect(initial.length).toBeGreaterThan(8);
  expect(initial).not.toBe('Not shown again');
  await handoff.getByRole('button', { name: 'Dismiss' }).click();

  const exhibitor = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const stallPage = await exhibitor.newPage();
  await signIn(stallPage, email, initial, /\/change-password/);
  await stallPage.locator('input[name="currentPassword"]').fill(initial);
  await stallPage.locator('input[name="newPassword"]').fill(personal);
  await stallPage.locator('input[name="confirmPassword"]').fill(personal);
  await stallPage.getByRole('button', { name: 'Save and continue' }).click();
  await stallPage.waitForURL(/\/stall/);
  await expect(stallPage.getByRole('heading', { name: `Stall ${stallCode}` })).toBeVisible();

  const profile = await stallPage.request.get('/api/auth/profile');
  expect(profile.ok()).toBeTruthy();
  const body = await profile.json() as {
    role: string;
    mustChangePassword: boolean;
    scopes: Array<{ stall: { id: string; stallCode: string } | null; event: { id: string } }>;
  };
  expect(body.role).toBe('STALL');
  expect(body.mustChangePassword).toBe(false);
  expect(body.scopes[0]?.stall?.stallCode).toBe(stallCode);
  expect(body.scopes[0]?.event.id).toBe('regression-event');
  const stored = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { role: true, mustChangePassword: true, scopes: { select: { stallId: true, eventId: true } } },
  });
  expect(stored.role).toBe('STALL');
  expect(stored.mustChangePassword).toBe(false);
  expect(stored.scopes[0]?.stallId).toBe(body.scopes[0]?.stall?.id);
  expect(stored.scopes[0]?.eventId).toBe('regression-event');

  const other = await prisma.ticket.findFirst({
    where: { eventId: 'regression-event', stall: { stallCode: { not: stallCode } } },
    select: { id: true },
  });
  if (other) expect((await stallPage.request.get('/api/tickets/' + other.id)).status()).toBe(403);

  console.log(`Vacant-stall handoff completed for ${stallCode}`);
  await exhibitor.close();
  await admin.close();
});

async function signIn(page: Page, email: string, secret: string, url: RegExp) {
  await page.goto('/login');
  await page.locator('input[name="userId"]').fill(email);
  await page.locator('input[name="password"]').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(url, { timeout: 20_000 });
}

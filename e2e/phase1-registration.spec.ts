import { expect, test, type Page } from '@playwright/test';

const password = process.env.REGRESSION_FIXTURE_PASSWORD ?? '';

test.beforeAll(() => {
  if (password.length < 12) throw new Error('Set REGRESSION_FIXTURE_PASSWORD before browser regression. Do not commit it.');
});

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test('exhibitor visibility and admin registration journeys', async ({ browser }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString(36);
  const stallCode = `P1-${suffix}`.slice(0, 18);
  const email = `regression.p1.${suffix}@volume.lab`;
  const personal = `Phase1${suffix}a1`;

  const admin = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const adminPage = await admin.newPage();
  await signIn(adminPage, 'regression.admin@volume.lab', password, /\/admin/);
  await adminPage.goto('/admin/registrations');
  await expect(adminPage.getByRole('heading', { name: 'Stall registrations' })).toBeVisible();
  await expect(adminPage.getByRole('heading', { name: 'Exhibitor accounts' })).toBeVisible();

  const vacant = adminPage.locator('article').filter({ hasText: 'H4-VACANT' }).first();
  await expect(vacant.getByText('No exhibitor login yet')).toBeVisible();
  await expect(vacant.getByRole('button', { name: 'Create exhibitor login' })).toBeVisible();

  const create = adminPage.locator('form.registration-create');
  await expect(create.getByRole('button', { name: 'Create stall and exhibitor login' })).toBeEnabled();
  await create.locator('select[name="zoneId"]').selectOption({ index: 1 });
  await create.locator('input[name="stallCode"]').fill(stallCode);
  await create.locator('input[name="exhibitorName"]').fill('Phase 1 booth');
  await create.locator('input[name="loginName"]').fill('Phase 1 exhibitor');
  await create.locator('input[name="loginEmail"]').fill(email);
  const createdResponse = adminPage.waitForResponse((response) =>
    response.url().includes('/api/management/registrations/with-login') && response.request().method() === 'POST');
  await create.getByRole('button', { name: 'Create stall and exhibitor login' }).click();
  const created = await createdResponse;
  expect(created.ok()).toBeTruthy();
  const createdBody = created.request().postDataJSON() as Record<string, string>;
  const handoff = adminPage.getByRole('status', { name: 'Exhibitor login instructions' });
  await expect(handoff).toBeVisible();
  await expect(handoff.getByText(email)).toBeVisible();
  await expect(handoff.getByText('Initial password', { exact: true })).toBeVisible();
  const initial = await handoff.locator('dd').nth(2).innerText();
  expect(initial.length).toBeGreaterThan(8);
  expect(initial).not.toBe('Not shown again');
  await handoff.getByRole('button', { name: 'Dismiss' }).click();
  await expect(handoff).toBeHidden();

  const replay = await adminPage.evaluate(async (body) => {
    const response = await fetch('/api/management/registrations/with-login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { created?: boolean; credentialIssued?: boolean; handoff?: { initialCredential?: string | null } };
    return {
      status: response.status,
      created: payload.created === true,
      credentialIssued: payload.credentialIssued === true,
      showsCredential: Boolean(payload.handoff?.initialCredential),
    };
  }, createdBody);
  expect(replay.status).toBe(201);
  expect(replay.created).toBe(false);
  expect(replay.credentialIssued).toBe(false);
  expect(replay.showsCredential).toBe(false);

  await create.locator('select[name="zoneId"]').selectOption({ index: 1 });
  await create.locator('input[name="stallCode"]').fill(stallCode);
  await create.locator('input[name="exhibitorName"]').fill('Phase 1 booth');
  await create.locator('input[name="loginName"]').fill('Phase 1 duplicate');
  await create.locator('input[name="loginEmail"]').fill(`other.${suffix}@volume.lab`);
  await create.getByRole('button', { name: 'Create stall and exhibitor login' }).click();
  await expect(adminPage.locator('.form-error')).toContainText(`Stall code ${stallCode} is already used in this zone`);

  await adminPage.reload();
  const row = adminPage.locator('article').filter({ hasText: stallCode }).first();
  await expect(row.getByText('password change required')).toBeVisible();
  await adminPage.screenshot({ path: `test-results/phase1/admin-registrations-desktop.png`, fullPage: true });
  await adminPage.setViewportSize({ width: 390, height: 800 });
  const mobileOverflow = await adminPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(mobileOverflow).toBeLessThanOrEqual(8);
  await adminPage.screenshot({ path: 'test-results/phase1/admin-registrations-mobile.png', fullPage: true });

  const exhibitor = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const stallPage = await exhibitor.newPage();
  await signIn(stallPage, email, initial, /\/change-password/);
  await stallPage.locator('input[name="currentPassword"]').fill(initial);
  await stallPage.locator('input[name="newPassword"]').fill(personal);
  await stallPage.locator('input[name="confirmPassword"]').fill(personal);
  await stallPage.getByRole('button', { name: 'Save and continue' }).click();
  await stallPage.waitForURL(/\/stall/);
  await expect(stallPage.getByRole('heading', { name: `Stall ${stallCode}` })).toBeVisible();
  await expect(stallPage.getByText(/snooze|queue priority|SLA/i)).toHaveCount(0);
  await stallPage.getByRole('button', { name: 'Raise a ticket' }).click();
  await stallPage.getByLabel('House Help').check();
  await stallPage.locator('textarea[name="description"]').fill('Need a chair moved for the booth');
  await stallPage.getByRole('button', { name: 'Raise ticket' }).click();
  await expect(stallPage.getByRole('heading', { name: /confirmed/i })).toBeVisible();
  await stallPage.getByRole('button', { name: 'View ticket' }).click();
  await expect(stallPage.getByText(/Waiting for assistance|Staff assigned|Request received/)).toBeVisible();
  await stallPage.locator('a.ticket-link').first().click();
  await expect(stallPage.getByRole('heading', { name: 'Activity' })).toBeVisible();
  await expect(stallPage.getByText('Your request was received.')).toBeVisible();
  await expect(stallPage.getByText(/ASSIGNMENT_SNOOZED|SERVICE_PRIORITY|SLA_BREACHED|queue priority/i)).toHaveCount(0);
  await stallPage.setViewportSize({ width: 1280, height: 800 });
  await expect(stallPage.getByRole('heading', { name: 'Activity' })).toBeVisible();
  const desktopOverflow = await stallPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(desktopOverflow).toBeLessThanOrEqual(1);
  await stallPage.screenshot({ path: 'test-results/phase1/exhibitor-activity-desktop.png', fullPage: true });
  await stallPage.setViewportSize({ width: 390, height: 800 });
  await stallPage.screenshot({ path: 'test-results/phase1/exhibitor-activity-mobile.png', fullPage: true });

  await adminPage.setViewportSize({ width: 1280, height: 800 });
  await row.getByRole('button', { name: 'Reset initial password' }).click();
  const resetHandoff = adminPage.getByRole('status', { name: 'Exhibitor login instructions' });
  await expect(resetHandoff).toBeVisible();
  await resetHandoff.getByRole('button', { name: 'Dismiss' }).click();
  await expect(adminPage.locator('.alert-line')).toContainText('Earlier sessions for this account are signed out.');
  await stallPage.reload();
  await stallPage.waitForURL(/\/login/);
  await expect(stallPage.getByRole('heading', { name: 'Sign in to EveOps' })).toBeVisible();

  await exhibitor.close();
  await admin.close();
});

async function signIn(page: Page, email: string, secret: string, url: RegExp) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(url, { timeout: 20_000 });
}

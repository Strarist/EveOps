import { expect, test, type Page } from '@playwright/test';

const password = process.env.REGRESSION_FIXTURE_PASSWORD ?? '';
const widths = [360, 390, 768, 1024, 1440];

test.beforeAll(() => {
  if (password.length < 12) throw new Error('Set REGRESSION_FIXTURE_PASSWORD before browser regression. Do not commit it.');
});

test('electrician and house help task lists stay usable', async ({ browser }) => {
  test.setTimeout(240_000);
  const electrician = await browser.newContext();
  const page = await electrician.newPage();
  await signIn(page, 'regression.elec.h1.2@volume.lab');
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole('heading', { name: 'Electrician H1.2' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active tasks' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/staff/electrician-${width}.png`, fullPage: true });
  }
  const open = page.getByRole('link', { name: 'Open task' });
  if (await open.count()) {
    await open.first().click();
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to tasks' })).toBeVisible();
    await page.screenshot({ path: 'test-results/staff/electrician-task-390.png', fullPage: true });
    await page.getByRole('link', { name: 'Back to tasks' }).click();
    await expect(page.getByRole('heading', { name: 'Active tasks' })).toBeVisible();
  }
  await page.getByRole('link', { name: 'Completed' }).click();
  await expect(page.getByRole('heading', { name: 'Completed tasks' })).toBeVisible();
  await page.getByRole('link', { name: 'Availability' }).click();
  await expect(page.getByRole('heading', { name: 'Availability' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable work alerts and continue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn sound on' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Turn sound off' })).toHaveCount(0);
  await electrician.close();

  const house = await browser.newContext();
  const help = await house.newPage();
  await signIn(help, 'regression.help.h2.1@volume.lab');
  await help.setViewportSize({ width: 390, height: 800 });
  await expect(help.getByRole('heading', { name: 'House help H2.1' })).toBeVisible();
  await expect(help.getByRole('heading', { name: 'Active tasks' })).toBeVisible();
  await help.screenshot({ path: 'test-results/staff/house-help-390.png', fullPage: true });
  await house.close();
});

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    const outcome = await Promise.race([
      page.waitForURL(/\/staff/, { timeout: 20_000 }).then(() => 'ok' as const),
      page.getByRole('alert').filter({ hasText: /too many/i }).waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'limited' as const),
    ]).catch(() => 'failed' as const);
    if (outcome === 'ok') return;
    if (outcome === 'limited') {
      await page.waitForTimeout(61_000);
      continue;
    }
    throw new Error('Sign-in did not open the workspace');
  }
}

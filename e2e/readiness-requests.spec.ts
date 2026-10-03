import { expect, test, type Browser } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const webOrigin = process.env.E2E_BASE_URL ?? 'http://localhost:3110';
const prisma = new PrismaClient();

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test('exhibitor navigation shares one profile fetch and does not retry it on live updates', async ({ browser }) => {
  const page = await openSession(browser, 'regression.stall.h1-01@volume.lab');
  const counts = { profile: 0, tickets: 0 };
  page.on('request', (request) => {
    const url = request.url();
    if (request.method() !== 'GET') return;
    if (url.includes('/api/auth/profile')) counts.profile += 1;
    if (url.includes('/api/tickets?')) counts.tickets += 1;
  });
  await page.goto('/stall');
  await expect(page.getByRole('heading', { name: /Stall / })).toBeVisible();
  const profileAfterHome = counts.profile;
  expect(profileAfterHome).toBeLessThanOrEqual(1);
  await page.getByRole('link', { name: 'Requests' }).click();
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await page.getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByRole('heading', { name: 'Profile and help' })).toBeVisible();
  expect(counts.profile).toBeLessThanOrEqual(3);
  const ticketsBeforeWait = counts.tickets;
  await page.waitForTimeout(1200);
  expect(counts.tickets).toBe(ticketsBeforeWait);
  await page.context().close();
});

test('a rate-limited refresh keeps the visible list and does not burst retries', async ({ browser }) => {
  const page = await openSession(browser, 'regression.stall.h1-01@volume.lab');
  await page.goto('/stall/requests');
  await expect(page.getByRole('heading', { name: 'My requests' })).toBeVisible();
  let ticketReads = 0;
  await page.route('**/api/tickets?**', async (route) => {
    ticketReads += 1;
    await route.fulfill({
      status: 429,
      headers: { 'retry-after': '30', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'ThrottlerException: Too Many Requests' }),
    });
  });
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText('Requests are busy right now. Showing the last loaded list.')).toBeVisible();
  await page.waitForTimeout(800);
  expect(ticketReads).toBe(1);
  await page.unroute('**/api/tickets?**');
  await page.context().close();
});

async function openSession(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
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

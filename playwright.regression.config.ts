import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';

export default defineConfig({
  testDir: './e2e',
  testMatch: /regression-(smoke|staff)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bash scripts/dev-regression.sh',
    url: 'http://localhost:4100/api/system/health',
    reuseExistingServer: true,
    timeout: 180_000,
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://eveops:eveops@localhost:55432/eveops_regression?schema=public',
      ALLOW_DEMO_SEED: 'false',
      EVEOPS_REQUIRE_DATABASE: 'eveops_regression',
      REGRESSION_WEB_PORT: '3100',
      REGRESSION_API_PORT: '4100',
    },
  },
});

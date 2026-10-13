import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Regression / phase browser suites need eveops_regression + playwright.regression.config.ts.
  testIgnore: [
    'regression-smoke.spec.ts',
    'regression-staff.spec.ts',
    'phase1-registration.spec.ts',
    'phase2-alerts.spec.ts',
    'phase3a-manager.spec.ts',
    'phase3a-pagination.spec.ts',
    'phase3b-stall.spec.ts',
    'phase3c-admin.spec.ts',
    'phase3d-super.spec.ts',
    'phase4-vacant-stall.spec.ts',
    'readiness-requests.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Wait for API health (not only the Next login page) so ticket APIs are ready.
    command: 'npm run dev',
    url: 'http://localhost:4000/api/system/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});

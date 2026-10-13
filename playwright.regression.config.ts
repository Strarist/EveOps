import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: './e2e',
  testMatch: [
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
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: 'test-results/e2e',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bash scripts/prod-regression.sh',
    url: `${process.env.API_URL ?? 'http://127.0.0.1:4100/api'}/system/health`,
    reuseExistingServer: true,
    timeout: 600_000,
  },
});

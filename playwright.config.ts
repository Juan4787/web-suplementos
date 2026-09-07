import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
const isRemoteUrl = baseURL.startsWith('https://');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60000,
  expect: {
    timeout: 15000
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    acceptDownloads: true
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } }
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] }
    },
    {
      name: 'firefox-smoke',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /01-storefront-checkout\.spec\.ts|02-import-order\.spec\.ts/
    }
  ],
  webServer: isRemoteUrl
    ? undefined
    : {
        command: 'VITE_APP_MODE=demo npm run dev',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120000
      }
});

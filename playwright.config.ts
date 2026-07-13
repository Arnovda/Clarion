import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    // Sandboxed/managed environments pre-install a Chromium build that may
    // not match this @playwright/test version's expected revision. Point
    // PLAYWRIGHT_CHROMIUM_PATH at that binary to use it; when unset (CI,
    // local dev after `npx playwright install`) default resolution applies.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  // Don't auto-start servers — they must be running already
});

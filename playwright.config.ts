import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: './tests/e2e/cleanup.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', browserName: 'chromium' },
  webServer: {
    command: 'pnpm exec concurrently -k \"pnpm exec tsx tests/e2e/server.ts\" \"pnpm dev:web\"',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
  },
});

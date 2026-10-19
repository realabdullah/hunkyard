import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: './tests/e2e/cleanup.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  // CLI journeys only: the fixture server writes a loopback model config they share.
  webServer: {
    command: 'pnpm exec tsx tests/e2e/server.ts',
    url: 'http://127.0.0.1:4317/api/v1/health',
    reuseExistingServer: false,
  },
});

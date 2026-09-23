import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/browser',
  // Authentication requests contain ephemeral credentials. Never record them.
  use: { trace: 'off', video: 'off', screenshot: 'off' },
});

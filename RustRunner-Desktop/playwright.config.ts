import { defineConfig } from '@playwright/test';

/**
 * Electron smoke tests. They drive the built app (dist/) with the real engine
 * binary, so run them through `npm run test:e2e`, which builds both first.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // One Electron app at a time: tests share the process table (they look for
  // leftover `sleep` processes) and the engine's temp directory logic.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './e2e/.tmp/results',
});

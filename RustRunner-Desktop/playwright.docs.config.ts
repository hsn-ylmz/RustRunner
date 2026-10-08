import path from 'path';
import { defineConfig } from '@playwright/test';

// Recording a video needs Playwright's own small ffmpeg build. It is kept inside the sandbox folder
// (installed by `npm run docs:gifs`), not in the person's home.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(__dirname, '../.sandbox/pw-browsers');

/**
 * Records the screen captures used by the README and the project site
 * (`npm run docs:gifs`). Not part of `npm run test:e2e`: the recordings use the
 * real engine and take minutes.
 */
export default defineConfig({
  testDir: './docs-media',
  testMatch: '**/*.docs.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 20 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: '../.sandbox/docs-media/results',
});

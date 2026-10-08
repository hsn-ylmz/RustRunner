import { defineConfig } from 'vitest/config';

/**
 * Opt-in real-tool suite (`npm run test:tools`). It is not matched by the
 * default `vitest run` (its files end in `.tools.ts`) and is not part of CI.
 * The first run downloads conda packages, so the timeouts are generous.
 */
export default defineConfig({
  test: {
    include: ['test-tools/**/*.tools.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    fileParallelism: false,
    reporters: ['verbose'],
  },
});

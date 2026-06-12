import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000, // E2E tests may involve real sessions + cron waits
    // fix instar#1069: build dist before the run (idempotent; skips if current).
    globalSetup: ['tests/setup/build-dist.globalSetup.ts'],
  },
});

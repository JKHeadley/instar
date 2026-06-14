import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000, // Integration tests may spawn real sessions
    // fix instar#1069: build dist before the run so the dist-backed cartographer
    // worker test resolves the real compiled worker (idempotent; skips if current).
    globalSetup: ['tests/setup/build-dist.globalSetup.ts'],
  },
});

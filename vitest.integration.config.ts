import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

export default defineConfig(withTestRunnerBound('integration', {
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000, // Integration tests may spawn real sessions
    // fix instar#1069: build dist before the run so the dist-backed cartographer
    // worker test resolves the real compiled worker (idempotent; skips if current).
    // The test-runner semaphore globalSetup is PREPENDED by withTestRunnerBound
    // so setup() acquires BEFORE the dist build and teardown() releases after
    // it (globalSetup teardown runs in reverse — spec §2.2).
    globalSetup: ['tests/setup/build-dist.globalSetup.ts'],
  },
}));

/**
 * Meta-verification fixture config — the PREPEND shape (spec §2.2): this
 * config already carries its own globalSetup (like vitest.integration.config.ts
 * carries build-dist.globalSetup.ts). withTestRunnerBound must PREPEND the
 * semaphore chokepoint ahead of it, so acquire happens before the pre-existing
 * globalSetup AND before worker fanout.
 */
import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from '../../setup/test-runner-bound.config-eval.js';

export default defineConfig(
  withTestRunnerBound('unit', {
    test: {
      include: ['tests/fixtures/test-runner-bound/tests/quick-a.test.ts'],
      environment: 'node',
      testTimeout: 60_000,
      hookTimeout: 120_000,
      globalSetup: ['tests/fixtures/test-runner-bound/extra.globalSetup.ts'],
    },
  }),
);

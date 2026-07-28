/**
 * Meta-verification fixture config — the SMALL-POOL shape: a config whose
 * NATURAL resolved worker-pool bound is ≤ 4 (maxWorkers: 2). Under the §2.3
 * two-point state rule, a strictly-targeted argv against this config routes
 * to the TARGETED lane even in dry-run posture (no clamp needed) — used by
 * the lane-scope regression test (§2.5) to place a targeted-lane holder
 * without engaging the clamp path.
 */
import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from '../../setup/test-runner-bound.config-eval.js';

export default defineConfig(
  withTestRunnerBound('unit', {
    test: {
      include: ['tests/fixtures/test-runner-bound/tests/**/*.test.ts'],
      environment: 'node',
      testTimeout: 240_000,
      hookTimeout: 120_000,
      minWorkers: 1,
      maxWorkers: 2,
    },
  }),
);

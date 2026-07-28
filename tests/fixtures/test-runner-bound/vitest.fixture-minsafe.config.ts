/**
 * Meta-verification fixture config — the MIN-SAFE shape: identical to the
 * pinned config shapes EXCEPT it sets `minWorkers: 1` explicitly.
 *
 * Diagnostic purpose (§2.3/§2.5 clamp validation): on vitest 2.1.9,
 * createForksPool resolves `minThreads = poolOptions.minForks ?? config.minWorkers
 * ?? (numCpus - 1)`. clampConfigPool clamps only the MAX bounds, so on a
 * >4-core host a REAL clamp (clampActive/enforcing) yields minThreads > 4 =
 * maxThreads and Tinypool throws `options.minThreads and options.maxThreads
 * must not conflict`, crashing the root. This config removes that conflict so
 * the meta tests can prove the max-clamp itself reaches the pool — isolating
 * the defect to the unclamped MIN bound on the pinned config shapes.
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
    },
  }),
);

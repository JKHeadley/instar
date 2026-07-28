/**
 * Meta-verification fixture config (spec §5) — a minimal vitest project wired
 * through the REAL config-eval seam (withTestRunnerBound), exactly like the
 * five repo configs. Spawned by tests/integration/test-runner-bound-meta.test.ts
 * with cwd = repo root and INSTAR_HOST_TEST_BASE_DIR pointed at a per-test
 * temp universe — NEVER the real ~/.instar.
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
    },
  }),
);

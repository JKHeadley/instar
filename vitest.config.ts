import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

export default defineConfig(withTestRunnerBound('unit', {
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      // Real-world-state fixture tier (lever B from the 2026-05-29 pipeline
      // post-mortem). 'pr'-tier scenarios run every CI shard; 'nightly'-tier
      // is gated on INSTAR_REAL_WORLD_BIG=1 env (see _framework.ts).
      'tests/real-world-state/**/*.test.ts',
    ],
    // `npm test` is the command the Zero-Failure Standard names, and its `include`
    // covers tests/integration/** and tests/e2e/** — the production-path blocks that need
    // the gitignored packed asset. Without this it passes only if the one self-
    // bootstrapping unit file happens to run first, which is exactly the failure the
    // globalSetup's own comment names: a per-file bootstrap is invisible to the next file
    // that needs it. Round 6 caught that `vitest.push` and `vitest.integration` got it and
    // this config did not.
    // nativeModuleHealth is LAST in setup order, so its teardown runs FIRST —
    // teardowns run in reverse, and the banner belongs closest to the summary.
    globalSetup: ['tests/setup/build-dist.globalSetup.ts', 'tests/setup/nativeModuleHealth.globalSetup.ts'],
    setupFiles: ['./tests/vitest-setup.ts'],
    environment: 'node',
    testTimeout: 10000,
    // Run test files sequentially to prevent port collisions, file lock
    // contention, and resource races across files that spawn HTTP servers,
    // SQLite DBs, real npm operations, etc. Individual tests within each
    // file still run sequentially (vitest default for same-file tests).
    fileParallelism: false,
  },
}));

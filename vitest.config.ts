import { defineConfig } from 'vitest/config';

import { supertestRetryAlias } from './tests/setup/supertest-alias.js';

import { resolveUnitLaneWorkers } from './tests/setup/lane-workers.js';
import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

const unitWorkers = resolveUnitLaneWorkers();

export default defineConfig(withTestRunnerBound('unit', {
  // Inline (empty) PostCSS config: without it Vite searches parent directories for one and
  // aborts on the first unreadable package.json (EPERM). The feedback executor's sandbox
  // read-denies the agent home around its workspace, so every confined vitest run failed.
  css: { postcss: {} },
  // threadline-core is a workspace package that threadline-mcp imports by its published name.
  // Tests resolve it to the live source so cross-implementation tests need no install or build
  // (spec threadline-standalone-pairing).
  resolve: { alias: [{ find: '@sagemindai/threadline-core', replacement: new URL('./packages/threadline-core/src/index.ts', import.meta.url).pathname }, supertestRetryAlias] },
  test: {
    // The unit lane only. Integration and e2e have their own configs and lanes
    // (`npm run test:all` runs all three, one after another); including them here
    // ran every integration and e2e file twice under `test:all`.
    include: [
      'tests/unit/**/*.test.ts',
      // Real-world-state fixture tier (lever B from the 2026-05-29 pipeline
      // post-mortem). 'pr'-tier scenarios run every CI shard; 'nightly'-tier
      // is gated on INSTAR_REAL_WORLD_BIG=1 env (see _framework.ts).
      'tests/real-world-state/**/*.test.ts',
    ],
    // Several unit files exercise production-path blocks that need dist and the
    // gitignored packed asset. A per-file bootstrap is invisible to the next file
    // that needs it, so the build runs once here, before any worker starts.
    // nativeModuleHealth is LAST in setup order, so its teardown runs FIRST —
    // teardowns run in reverse, and the banner belongs closest to the summary.
    globalSetup: ['tests/setup/build-dist.globalSetup.ts', 'tests/setup/nativeModuleHealth.globalSetup.ts'],
    setupFiles: ['./tests/vitest-setup.ts'],
    environment: 'node',
    // Includes the bounded Supertest connect-retry window used under macOS
    // loopback pressure. Tests with genuinely longer waits declare their own cap.
    testTimeout: 120000,
    // Unit files run in parallel (spec local-verify-merge-authority §1).
    // INSTAR_TEST_WORKERS overrides the count; the host test-runner bound may
    // still clamp a nested or targeted run.
    fileParallelism: true,
    minWorkers: 1,
    maxWorkers: unitWorkers,
  },
}));

import { defineConfig } from 'vitest/config';

import { supertestRetryAlias } from './tests/setup/supertest-alias.js';

import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

export default defineConfig(withTestRunnerBound('e2e', {
  // Inline (empty) PostCSS config: without it Vite searches parent directories for one and
  // aborts on the first unreadable package.json (EPERM). The feedback executor's sandbox
  // read-denies the agent home around its workspace, so every confined vitest run failed.
  css: { postcss: {} },
  // threadline-core is a workspace package that threadline-mcp imports by its published name.
  // Tests resolve it to the live source so cross-implementation tests need no install or build
  // (spec threadline-standalone-pairing).
  resolve: { alias: [{ find: '@sagemindai/threadline-core', replacement: new URL('./packages/threadline-core/src/index.ts', import.meta.url).pathname }, supertestRetryAlias] },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    // Includes the bounded Supertest connect-retry window used under aggregate
    // macOS loopback pressure. Individual long waits still declare their own cap.
    testTimeout: 120000,
    // Builds dist first (idempotent: a no-op when dist is newer than src), then
    // ensures the gitignored registry asset. The dist-gated e2e files used to
    // run only under vitest.config.ts, which included tests/e2e/**; that config
    // is now the unit lane alone, so this lane builds for itself.
    globalSetup: ['tests/setup/build-dist.globalSetup.ts', 'tests/setup/ensure-registry-asset.globalSetup.ts'],
    // E2E tests spawn shipped scripts and real framework-shaped sessions. Keep
    // the same live-agent environment isolation as the default suite so an
    // ambient INSTAR_FRAMEWORK/AGENT_HOME cannot redirect a fixture into the
    // operator's running agent.
    setupFiles: ['./tests/vitest-setup.ts'],
    // Real tmux/session fixtures include legacy prefix-wide cleanup helpers.
    // Keep files sequential so one suite cannot reap another suite's live pane.
    fileParallelism: false,
  },
}));

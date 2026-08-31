import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

export default defineConfig(withTestRunnerBound('e2e', {
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    // Includes the bounded Supertest connect-retry window used under aggregate
    // macOS loopback pressure. Individual long waits still declare their own cap.
    testTimeout: 120000,
    // Asset-only: production registry resolution needs its gitignored generated
    // data on a fresh checkout, but this config deliberately does NOT compile
    // dist — a build here would cost every e2e run a full tsc.
    //
    // The dist-gated tests are NOT dormant. `vitest.config.ts` (what `npm test`
    // and the CI unit shards run) includes `tests/e2e/**` AND wires
    // build-dist.globalSetup, so all three run there — verified 2026-07-28 by
    // executing cli-unknown-command under that config: 2 tests, 512ms + 387ms of
    // real work, not instant returns. Skipping here is duplicate-coverage
    // avoidance, not an excuse to leave them unrun.
    //
    // The previous note here justified the skip by saying dev-preflight-cli
    // "spawns `pnpm` — absent on the CI e2e runner". That is no longer true:
    // PR #1712 made the preflight resolve its package manager (pnpm, else
    // `npm run lint`), and it exits 0 under a pnpm-free PATH. The obstacle the
    // comment described is gone; the cost argument above is the reason that
    // remains.
    globalSetup: ['tests/setup/ensure-registry-asset.globalSetup.ts'],
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

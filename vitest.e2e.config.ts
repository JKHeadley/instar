import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

export default defineConfig(withTestRunnerBound('e2e', {
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000, // E2E tests may involve real sessions + cron waits
    // Asset-only: production registry resolution needs its gitignored generated
    // data on a fresh checkout, but E2E still deliberately does NOT compile dist.
    // A tsc/build globalSetup would wake dormant dist-gated tests (e.g.
    // dev-preflight-cli, which spawns `pnpm` — absent on the CI e2e runner) that
    // skip-by-design when dist is missing.
    globalSetup: ['tests/setup/ensure-registry-asset.globalSetup.ts'],
  },
}));

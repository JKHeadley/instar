import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000, // E2E tests may involve real sessions + cron waits
    // NOTE (fix instar#1069): deliberately NO build-dist globalSetup here. The only
    // dist-backed test lives in the INTEGRATION config; e2e tests run the sync
    // detect. Building dist in the e2e job would also wake dormant dist-gated
    // tests (e.g. dev-preflight-cli, which spawns `pnpm` — absent on the CI e2e
    // runner) that skip-by-design when dist is missing.
  },
});

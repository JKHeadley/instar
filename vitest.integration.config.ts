import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

export default defineConfig(withTestRunnerBound('integration', {
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // Includes the bounded Supertest connect-retry window used under aggregate
    // macOS loopback pressure. Individual long waits still declare their own cap.
    testTimeout: 120000,
    // fix instar#1069: build dist before the run so the dist-backed cartographer
    // worker test resolves the real compiled worker (idempotent; skips if current).
    // The test-runner semaphore globalSetup is PREPENDED by withTestRunnerBound
    // so setup() acquires BEFORE the dist build and teardown() releases after
    // it (globalSetup teardown runs in reverse — spec §2.2).
    globalSetup: ['tests/setup/build-dist.globalSetup.ts'],
    // Integration tests spawn shipped scripts and framework-shaped sessions;
    // strip ambient live-agent routing/auth variables before each file.
    setupFiles: ['./tests/vitest-setup.ts'],
    fileParallelism: false,
    // Keep the full integration lane in one worker process. With multiple
    // reusable workers, Node can recycle a just-closed ephemeral localhost
    // port while another worker still owns a pooled HTTP connection for that
    // origin. The next otherwise-hermetic route test can then receive the
    // previous fixture server's 401. The suite is already file-serial, so one
    // worker removes that cross-fixture socket identity race without reducing
    // file-level parallelism (there is none in this lane).
    minWorkers: 1,
    maxWorkers: 1,
  },
}));

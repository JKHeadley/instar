/**
 * Vitest config for contract tests — tests that hit REAL external APIs.
 *
 * Contract tests verify that our assumptions about external API behavior
 * (response shapes, error codes, redirect behavior, auth requirements)
 * match reality. They require real credentials via environment variables.
 *
 * Run: SLACK_CONTRACT_BOT_TOKEN=xoxb-... npm run test:contract
 *
 * Tests skip gracefully when credentials are not set. When credentials ARE
 * set and tests fail, it means our code's assumptions are WRONG.
 */
import { defineConfig } from 'vitest/config';

import { withTestRunnerBound } from './tests/setup/test-runner-bound.config-eval.js';

export default defineConfig(withTestRunnerBound('contract', {
  // Inline (empty) PostCSS config: without it Vite searches parent directories for one and
  // aborts on the first unreadable package.json (EPERM). The feedback executor's sandbox
  // read-denies the agent home around its workspace, so every confined vitest run failed.
  css: { postcss: {} },
  test: {
    include: ['tests/contract/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000, // External API calls can be slow
    fileParallelism: false,
  },
}));

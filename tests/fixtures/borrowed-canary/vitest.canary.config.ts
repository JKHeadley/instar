/**
 * Runs ONLY the borrowed-machine canary fixtures (docs/specs/local-verify-borrowed-unit-slices.md, F).
 * The helper's in-sandbox runner selects this config when every file of a slice is under
 * tests/fixtures/borrowed-canary/. No global setup: the canary needs no build.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: { postcss: {} },
  test: {
    include: ['tests/fixtures/borrowed-canary/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    fileParallelism: true,
  },
});

// Borrowed-machine known-red canary (docs/specs/local-verify-borrowed-unit-slices.md, F).
// NOT part of the unit lane: tests/fixtures/** is excluded from the inventory and vitest.config.ts.
// Expected: 1 passed, and one unhandled rejection that vitest reports as an unhandled error
// (a nonzero exit with no failed test: a slice-level error).
import { expect, it } from 'vitest';

it('canary passes but leaves an unhandled rejection', async () => {
  void Promise.reject(new Error('canary: unhandled rejection'));
  await new Promise((r) => setTimeout(r, 20));
  expect(true).toBe(true);
});

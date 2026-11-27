// Borrowed-machine known-red canary (docs/specs/local-verify-borrowed-unit-slices.md, F).
// NOT part of the unit lane: tests/fixtures/** is excluded from the inventory and vitest.config.ts.
// Expected: 1 passed, 1 failed (an assertion failure). A helper reporting this file green is a false green.
import { expect, it } from 'vitest';

it('canary passes', () => { expect(true).toBe(true); });
it('canary fails on purpose', () => { expect(2 + 2).toBe(5); });

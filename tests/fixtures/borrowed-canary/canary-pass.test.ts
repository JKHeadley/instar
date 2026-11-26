// Borrowed-machine known-red canary (docs/specs/local-verify-borrowed-unit-slices.md, F).
// NOT part of the unit lane: tests/fixtures/** is excluded from the inventory and vitest.config.ts.
// Expected: 2 passed.
import { expect, it } from 'vitest';

it('canary passes (1)', () => { expect(1 + 1).toBe(2); });
it('canary passes (2)', () => { expect('a'.repeat(3)).toBe('aaa'); });

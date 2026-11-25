// Borrowed-machine known-red canary (docs/specs/local-verify-borrowed-unit-slices.md, F).
// NOT part of the unit lane: tests/fixtures/** is excluded from the inventory and vitest.config.ts.
// Expected: the file fails while loading (one failure, no assertions).
import { it } from 'vitest';

throw new Error('canary: thrown while the file loads');

it('never collected', () => { /* unreachable */ });

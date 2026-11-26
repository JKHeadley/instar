// Borrowed-machine known-red canary (docs/specs/local-verify-borrowed-unit-slices.md, F).
// NOT part of the unit lane: tests/fixtures/** is excluded from the inventory and vitest.config.ts.
// Expected: 1 passed, 1 skipped, 1 todo.
import { expect, it } from 'vitest';

it('canary passes', () => { expect(1).toBe(1); });
it.skip('canary is skipped', () => { expect(1).toBe(2); });
it.todo('canary is a todo');

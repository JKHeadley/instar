# Side effects: conversation-list pins, wiring test expectation

Change: tests/unit/chief-of-staff-surfaces-wiring.test.ts now expects the Conversations console to order its non-pinned rows with `orderWithTree(rest, this.pinnedKey)`. PR 3161 splits pinned conversations into their own group first, so the tree ordering (which keeps the Chief of Staff conversation at its root) now runs over the remaining rows. The intent the test guards, that the console still orders the list through orderWithTree with the pinned key, is unchanged.

1. Over-block: none; test-only change.
2. Under-block: the check is a source-text check; it still catches a removal of the tree ordering.
3. Level of abstraction: unchanged test layer.
4. Signal vs authority: no decision point.
5. Interactions: none.
6. External surfaces: none.
7. Multi-machine posture: not applicable (test only).
8. Rollback cost: revert the one line.

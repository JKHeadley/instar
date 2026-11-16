# Side-effects: meaning-search test after the conversation-list pins merge

Test-only change. After main (with PR 3161, conversation-list pins) was merged in, the migration test for the meaning-search line expected the search line to sit directly under the pinned messages line. The pins migration now correctly places its own line there first, so the test checks that the pinned messages line is present and that the meaning line replaces the keyword-only line, followed by the next line.

1. Over-block: none, no runtime change.
2. Under-block: the test still checks the replacement happens once and the old line is gone.
3. Level-of-abstraction fit: test expectation only.
4. Signal vs authority: no decision point touched.
5. Interactions: matches the merged order of the two migrations (list pins first, then search).
6. External surfaces: none.
7. Multi-machine posture: not applicable, test only.
8. Rollback cost: revert the one test hunk.

# Side-effects: dated preferences CLAUDE.md step runs after the Preferences section

The step that adds the GET /preferences line to an existing agent's CLAUDE.md ran before the step that adds the Preferences section. On a CLAUDE.md without that section, the first update added the section and the second update then added the line, so a second run changed the file. That failed 138 idempotency tests once main was merged in. The step now runs right after the Preferences section steps, in the same function, so one update places both and a second update changes nothing.

1. Over-block: none. Same sniff (session-context present, marker absent).
2. Under-block: an agent whose CLAUDE.md has no session-context text still gets no line, as before.
3. Level-of-abstraction fit: ordering inside the one CLAUDE.md patch function.
4. Signal vs authority: no decision point touched.
5. Interactions: now follows the Preferences and pooled-preferences steps; inserts after the session-context bullet.
6. External surfaces: CLAUDE.md text on update, unchanged wording.
7. Multi-machine posture: each machine updates its own CLAUDE.md, machine-local by design.
8. Rollback cost: revert the move.

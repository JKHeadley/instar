# Side-effects: file search CLAUDE.md step runs after the File Viewer section

The step that adds the file search line to an existing agent's CLAUDE.md ran before the step that adds the File Viewer section. On a CLAUDE.md without that section, the first update added the section and the second update then added the line, so a second run changed the file (the same idempotency failure PR 3177 hit). The step now runs right after the File Viewer section step, in the same function.

1. Over-block: none. Same sniff (/api/files/ present, search marker absent).
2. Under-block: none new.
3. Level-of-abstraction fit: ordering inside the one CLAUDE.md patch function.
4. Signal vs authority: no decision point touched.
5. Interactions: now follows the File Viewer section step; inserts after the "Generate a file link" bullet.
6. External surfaces: CLAUDE.md text on update, unchanged wording.
7. Multi-machine posture: each machine updates its own CLAUDE.md, machine-local by design.
8. Rollback cost: revert the move.

# Side-Effects Review — Split the templates.js import one symbol per line

## Summary of the change

`src/core/PostUpdateMigrator.ts` imported 26 symbols from `../scaffold/templates.js` on a single
line. Every PR that adds a CLAUDE.md awareness marker appends a symbol there, so two concurrent PRs
always conflicted on that exact line — hand-resolved five times on 2026-10-21 alone, and the operator
saw the resulting conflicts on consecutive PRs. The import is now one symbol per line, sorted, with a
ratchet test holding the shape.

## Decision-point inventory

- `PostUpdateMigrator.ts` templates.js import — **modify** — formatting only; same 26 symbols.
- `tests/unit/PostUpdateMigrator-templates-import-shape.test.ts` — **add** — ratchet.

## 1. Over-block

No block surface exists or is added. Import order is not semantic in TypeScript/ESM, so sorting
changes no behaviour and no evaluation order (the module is imported once either way).

## 2. Under-block

Nothing is relaxed. The compiler is the authority that every symbol still resolves, and `tsc
--noEmit` passes. The second ratchet test independently asserts every imported symbol is still
referenced in the file, so the reshuffle cannot have silently dropped or invented one.

## 3. Level-of-abstraction fit

The alternatives were: keep hand-resolving (the status quo — a recurring, operator-visible cost);
split the markers across several imports (more churn, same hot-spot risk); or move the marker list
into a data structure (a real refactor with behaviour risk, for a formatting problem). One symbol per
line is the smallest change that removes the shared-line collision.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

None added. The ratchet is a deterministic regex over the file's own text.

## 5. Interactions

- **Shadowing / double-fire / races:** none; this is a formatting change to one import statement.
- **In-flight PRs:** checked before changing a known hot line — none of the six currently armed PRs
  (#2208, #2209, #2210, #2213, #2218, #2219) touch `PostUpdateMigrator.ts`, so this creates no
  conflict for work already in flight. That check was the deciding factor in doing it now.
- **Feedback loops:** none.

## 6. External surfaces

None. No route, no operator action, no persisted state, no network, no timing dependence.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. The operator-visible effect is the absence of a recurring conflict prompt.

## 7. Multi-machine posture (Cross-Machine Coherence)

None. A source-formatting change with no replicated state and no lease interaction.

## 8. Rollback cost

Revert one commit. The ratchet test goes with it, so nothing is left asserting a shape that no longer
exists.

## Conclusion

Proceed. It removes a recurring, operator-visible cost at no behavioural risk, and the ratchet keeps
the benefit from eroding.

## Second-pass review (if required)

Not required — Tier 1: formatting of one import plus a test. No decision point, no block surface, no
persisted state, no config.

## Evidence pointers

- `tsc --noEmit` passes: all 26 symbols still resolve.
- `git diff --stat`: `1 file changed, 33 insertions(+), 1 deletion(-)` — import-only.
- Ratchet has teeth, verified both ways: collapsing the import back to one line fails both tests
  (`2 failed`); restored, `2 passed`.
- The recurring cost is first-hand rather than inferred: this same line was resolved by symbol-union
  five times during the 2026-10-21 session (PRs #2201/#2261 and the intermediate re-merges).

## Class-Closure Declaration (display-only mirror)

The class is "single-line imports in instar that every awareness-marker PR must append to". The
members are the templates.js imports consumed by the migrator; this is the one that actually collides
because it is the one every marker PR touches. The ratchet closes it for this import by construction
— a collapsed import now fails CI rather than relying on anyone noticing.

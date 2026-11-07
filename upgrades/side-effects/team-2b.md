# Side effects: team access on several machines (step 2b)

**Status:** pure rules only so far, in `src/core/TeamAccessMerge.ts`. Nothing calls them yet, so behaviour is unchanged.
**Over-block:** none yet. Once wired, a gap holds every team person until settled, which is deliberate.
**Under-block:** rows only one sleeping machine holds cannot be detected, a stated limit in the spec.
**Level:** pure functions of a set of rows, so two machines holding the same rows reach the same answer. Tests check every arrival order, and each rule was removed in turn to confirm a test fails.
**Signal vs authority:** this is the authority for who has access once wired; it holds none today.
**Rollback:** delete the file; nothing imports it.

## Chained rows
New rows carry origin, incarnation, a hash of the row before and a signed seen-vector. Rows from a 2a build stay valid and are anchored by a prefix hash, so an existing agent keeps its log. On one machine the only behaviour change is that a replaced row now reads as damage even where the numbers still run. A restore starts a new incarnation.

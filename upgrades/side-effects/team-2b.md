# Side effects: team access on several machines (step 2b)

**Status:** pure rules only so far, in `src/core/TeamAccessMerge.ts`. Nothing calls them yet, so behaviour is unchanged.
**Over-block:** none yet. Once wired, a gap holds every team person until settled, which is deliberate.
**Under-block:** rows only one sleeping machine holds cannot be detected, a stated limit in the spec.
**Level:** pure functions of a set of rows, so two machines holding the same rows reach the same answer. Tests check every arrival order, and each rule was removed in turn to confirm a test fails.
**Signal vs authority:** this is the authority for who has access once wired; it holds none today.
**Rollback:** delete the file; nothing imports it.

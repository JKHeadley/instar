# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The atomic-writes consistency test could not detect the defect it exists to detect.

Measured rather than argued: a bare `fs.writeFileSync` of durable session state, inserted into
`saveSession` — a DECLARED method of a DECLARED module — passed all 21 of its assertions.

Three causes, all fixed:

1. **Scoping.** `inSaveMethod` was set when a method NAME appeared on a line and never reset, while
   `hasWriteFile`/`hasRename` were re-zeroed at each occurrence. Only the window from the LAST name
   mention to EOF reached the assertion — 125 of 617 lines (20%) in `StateManager.ts`, leaving three
   of its four declared methods structurally unreachable. Bodies are now brace-matched per method.
2. **File-scope substring checks.** `source.includes('renameSync')` and `source.includes('.tmp')` are
   satisfied by one occurrence anywhere in the file, comments included. Pairing is now per body.
3. **Silent declaration rot.** A missing file was `it.skip`ped and a missing method never set the
   flag, so a rename dropped a module out of coverage without a sound. Both are failures now — and
   enabling that found two immediately: `saveState` has ZERO occurrences in `StateManager.ts` and in
   `QuotaTracker.ts`. QuotaTracker's real writer, `updateState()`, is atomic and had never been
   verified by this test. The declared list is corrected here.

**Delegation.** `StateManager` funnels every write through a private `atomicWrite()`. A naive
per-method rule would have failed the best-written module in the set for being well written, so one
level of `this.helper()` delegation is resolved and the funnel is what gets verified — which means
`StateManager`'s writes are now genuinely checked, where before nothing checked them.

Added `tests/helpers/atomicWriteScope.ts` (`stripComments`, `methodBodies`, `delegateTargets`,
`classifyMethod`) and `tests/unit/atomic-write-scope.test.ts`.

**Declared open in the source:** the module list is curated at 7 entries and says nothing about the
hundreds of other files under `src/` that call `writeFileSync`; delegation resolves one level within
one file; only `writeFileSync`/`renameSync` are recognised.

**The production code is atomic** everywhere the check now looks. This fixes a weak instrument, not a
live corruption bug.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).

## Evidence

- `tests/unit/atomic-write-scope.test.ts` — 18/18 green (6 defect cases, 6 over-block controls, 6 primitives).
- `tests/unit/atomic-writes-consistency.test.ts` — 32/32 green against the real tree.
- **Both-directions proof in ONE worktree**, shipped check restored from git alongside the new one so
  subject and control share a boundary: shipped → **21/21 PASSED** against the mutation; new →
  **1 failed / 31 passed**, naming file, method, deciding body and line. `src/core/StateManager.ts`
  restored byte-exact (sha match, zero markers, zero stray files).
- Six over-block controls pass under BOTH behaviours — genuine funnel delegation, in-body
  tmp-then-rename, a method that writes nothing, a commented-out write, a call site vs a declaration,
  and worst-verdict-wins across duplicate declarations.
- `tsc --noEmit` exit 0 — with the boundary stated: `tsconfig.json` excludes `tests`, so that run says
  nothing about these files.

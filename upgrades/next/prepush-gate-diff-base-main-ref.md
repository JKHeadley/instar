<!-- bump: patch -->
<!-- internal-only -->

## What Changed

`scripts/pre-push-gate.js` computed its "what files did this PR change" diff against `@{u}` (the
branch's own upstream). When a PR is updated by MERGING main in (the no-force-push path to resolve
conflicts), `@{u}...HEAD` then includes all of main's already-shipped files, so the gate's
src→fragment / src→tests / internal-only checks false-flag 173+ unrelated files and force
`INSTAR_PRE_PUSH_SKIP=1` (hit on #663, and complicated #766's re-trigger). The gate now diffs
against the PR's merge target (`JKHeadley/main`||`origin/main`||`upstream/main`||`main`), falling
back to `@{u}` only when no main ref resolves. A three-dot diff against main is the PR's true diff
in both the normal-incremental and merge-from-main cases and never under-reports the PR's changes.

## Evidence

- Reproduced on #663 (merge-from-main → 173 false `src/` files → forced SKIP=1).
- Safe-by-construction: `main...HEAD` (merge-base = branch point) always contains all the PR's
  commits, so it can never under-report; the only error direction is over-reporting (safe).
- 16 `tests/unit/pre-push-gate.test.ts` pass (incl. a new source-presence test for the main-ref
  base); `node --check scripts/pre-push-gate.js` clean. Self-uses the internal-only lane (scripts +
  test only, no `src/`).

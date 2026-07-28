# Side-Effects Review — pre-push gate diffs against the main ref, not @{u}

**Version / slug:** `prepush-gate-diff-base-main-ref`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required (build-gate diff base; safe-by-construction)`

## Summary

`scripts/pre-push-gate.js` computed `changedFiles` via `git diff --name-only ${remoteBranch}...HEAD`
where `remoteBranch = @{u}` (the branch's OWN upstream). That breaks when a PR is updated by
MERGING main in (the no-force-push path used to resolve conflicts): `@{u}...HEAD` then includes
ALL of main's already-shipped changes, so the gate's section-3/3b checks see 173+ unrelated `src/`
files → false "src changed without a release-note fragment" errors, forcing `INSTAR_PRE_PUSH_SKIP=1`
(hit live on #663). The fix computes the diff against the PR's MERGE TARGET — the first resolvable
of `JKHeadley/main`/`origin/main`/`upstream/main`/`main` — falling back to the old `@{u}` behaviour
only when no main ref resolves.

## 1. Over-block (what it still flags)

Unchanged for the normal incremental-push case: `main...HEAD` (three-dot, from the merge-base =
the branch point) == the PR's commits == what `@{u}...HEAD` gave for a never-merged-main branch.
The src→tests, src→fragment (#23), and internal-only (§3c) checks all still fire on the PR's real
`src/` changes. The "chore: release" commit (upgrades/ + version, no `src/`) still doesn't trip
section-3b, same as before.

## 2. Under-block (what it now lets through)

Nothing it shouldn't. A three-dot diff against main can NEVER under-report the PR's own changes
(the merge-base of main and HEAD is the branch point, so all the PR's commits are in the diff). The
only direction it can err is OVER-reporting (if a branch is based off another branch, not main) —
the safe direction (extra false-positives, never a missed src-change-without-fragment). The fix
specifically REMOVES the merge-from-main false-positive without weakening any check.

## 3. Blast radius

One file: `scripts/pre-push-gate.js` (the `changedFiles` computation feeding sections 3/3b/3c) +
its unit test. No `src/`, no runtime, no agent surface. `pickRef` is a local helper; on any error
it falls through to the prior `@{u}` logic, so a clone without a `main` remote behaves exactly as
before.

## 4. Reversibility

Fully reversible: revert the one hunk. No state. Verified: `node --check` clean; 16 pre-push-gate
unit tests pass.

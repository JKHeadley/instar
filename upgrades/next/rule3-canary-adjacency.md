<!-- bump: patch -->

## What Changed

The Rule 3 gate's canary check credited a file if **any** staged file had a canary-ish basename — it
never referenced the file under test, so it was a property of the commit rather than a relationship.
`src/` holds 11 canary-named files, so any broad commit touching one satisfied the canary half of Rule 3
for everything else in the change. It failed in the permissive direction, which is why it went unnoticed.

Underneath it, the canary-directory probe computed `<parent-of-dir>/canary` only, missing a source that
sits directly in an adapter root. The permissive fallback was masking that — so removing the fallback
alone would have turned a too-weak check into a wrong one.

Both fixed: the fallback now requires the canary to be in the file's own directory, and the probe covers
both layouts.

## What to Tell Your User

Nothing — a contributor-facing pre-commit script.

## Summary of New Capabilities

None. The gate is stricter: it stops granting canary credit that was never earned. A file carrying a
Rule 3.1 rationale is unaffected.

## Evidence

- Red → green: the new unrelated-canary test fails without the change (1 failed / 26 passed), passes with
  it (27/27).
- The **second** bug was found because an existing test failed when I tightened the first. I assumed the
  test was wrong; it was describing a real directory layout the probe could not see.
- Held deliberately until #1701 landed — tightening this earlier would have surfaced main's latent Rule 3
  violations on every merge. Verified `mergeHeadIfMerging` is on `main` before proceeding.

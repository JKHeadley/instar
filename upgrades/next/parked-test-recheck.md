# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Adds `scripts/recheck-parked-tests.mjs` — the missing EXIT PATH for `vitest.push.config.ts`'s
`FLAKY_TESTS`. Entry to that list costs nothing (the file is classified as ordinary config, so
removing a guard from CI needs no artifact), and nothing ever re-checked whether a parked test could
return. Entry free, exit impossible, ungated surface monotonically growing.

The script reports which parked entries now pass deterministically and which point at files that no
longer exist. It never re-arms and never edits config.

## Evidence

Measured on current main, three consecutive runs each: `notification-spam-prevention.test.ts`
15/15/15, `message-formatter.test.ts` 17/17/17, `ReflectionConsolidator.test.ts` 16/16/16 — all parked
as broken or non-deterministic, all repaired at some point and never re-armed. Note the inverse of the
2026-06-05 note in that same file: those tests rotted while parked; these were fixed while parked.
Nobody noticed either way. Plus one dangling entry: `tests/unit/slack-stall-active-gate.test.ts` is
excluded and does not exist.

Falsified by restoring the naive parser:

```
× THE PARSER: prose in the array does not become an entry        → s own
× finds the dangling entry ...                                   → expected 42 to be less than 5
× REGRESSION: an apostrophe in a comment cannot corrupt the parse
  Tests  3 failed | 2 passed (5)
```

Restored byte-identical; 5 passed.

## Known limits

It never re-arms — a local deterministic-pass does not establish a CI pass, and a third of the list is
parked for a native-binding reason whose stated scope is "on this machine". Glob entries are reported
rather than resolved. Only a rotating slice runs per invocation, so a single run does not survey the
whole list; the output says how many it checked.

## Correction

The first (naive) parser reported 92 parked entries; the true count is 91. That wrong number was
published in the release note of the earlier re-arm change. Recorded rather than silently fixed.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).

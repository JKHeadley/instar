# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Window lifecycle evaluations reuse the obligation ledger already loaded for the current synchronous evaluation when building runtime executor snapshots. Live sessions, commitments, driver files, and evidence rechecks remain live.

## What to Tell Your User

A slow end-to-end lifecycle test runs faster because it avoids parsing the same ledger once per obligation. This does not change the evidence needed to pass the lifecycle gate.

## Summary of New Capabilities

No new capability or setting; this is a performance improvement in the existing lifecycle route.

## Evidence

On main commit `eebab6341` (the base at measurement time), the representative file took 193–194 seconds in two baseline runs and 145–147 seconds in two of three isolated final-code runs. The other isolated run took 229 seconds. In the full M5 suite it passed in 159 seconds. The result has meaningful variance and does not establish a whole-suite speedup. The full suite passed 53,836 unit, 4,991 integration, and 3,622 E2E tests.

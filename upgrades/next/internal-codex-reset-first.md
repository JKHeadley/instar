# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed
Internal Codex model calls now reuse the shared weekly reset preference after their existing account eligibility checks. Equal or unknown deadlines retain room ordering; other frameworks retain their prior behavior.

## What to Tell Your User
Internal Codex checks now use available allowance that expires sooner before drawing on accounts that reset later.

## Summary of New Capabilities
None. This repairs existing account selection.

## Evidence
A regression reproduced the former reserve-first choice. Focused unit, real-child integration and durable-pool restart lifecycle checks pass. Complete verification and live installation are tracked separately.

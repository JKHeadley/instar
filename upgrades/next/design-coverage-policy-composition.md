# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Added internal composition of declared design coverage, modes, tracked staging references and BASE-earned reduction signals. Both declarations validate completely before comparison. This component is not connected to the manual inspection command or merge decisions.

## What to Tell Your User

No new user-facing behavior. The design-checking foundation can now validate complete declarations before the remaining integration work.

## Summary of New Capabilities

No new command or active gate. The existing manual inspector still excludes coverage and modes.

## Evidence

Ten focused unit tests and three independent qualified reviews cover this pure component. No executed-check, full-suite, merge or release result is claimed.

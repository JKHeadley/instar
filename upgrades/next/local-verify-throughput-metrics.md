# Upgrade Guide — vNEXT
<!-- bump: patch -->
## What Changed
The verification coordinator records bounded exact-candidate observation, admission, dispatch and verdict timings. A read-only report distinguishes complete inventory verdicts from stopped or unknown attempts, and labels first-observed-head latency as a lower bound because actual publication time is unavailable.
## What to Tell Your User
We can now measure completed verification runs and the time after a candidate first reaches the test line. This adds measurements; it does not itself make tests faster or change which checks must pass.
## Summary of New Capabilities
Operators can print a read-only two-hour verification report. Missing historic publication times remain unknown, and unresolved observations do not claim that a candidate is still waiting.
## Evidence
The author recorded173unit, one real HTTP and one production-construction lifecycle check passing without skips. An initial unit fixture failure was preserved and corrected under fresh reviewed custody. A final report-label regression is separate from those backend results. Complete exact-head verification remains required; no live speed increase or activation is claimed.

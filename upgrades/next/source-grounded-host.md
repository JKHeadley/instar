<!-- internal-only -->

## What Changed

Added a manual host that runs the private source-grounded case pack end to end. It writes a blind reduction, plans case, arm and repeat trials with a seeded order, captures confined Claude answers, collects one Claude judge and one Codex judge, and reduces the results with the frozen judge-flow modules into per-arm totals. Also added a unit test that runs every node:test file under scripts/evaluation, which the vitest include list did not cover before.

## Evidence

All 17 host tests and the 8 existing evaluation node:test files pass. An independent second-pass review requested changes, and they are in (see the side-effects review). The new vitest wrapper passes 10 of 10.

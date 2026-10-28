# Complete pool coverage for script results

## What Changed

The script-result report now remembers every expected machine in the pool, including a machine that is temporarily absent. It marks pool coverage incomplete when a machine cannot be reached or its result journal was lost. A machine leaves the expected roster only after its membership is explicitly revoked.

## What to Tell Your User

The pool accuracy report will say when it is missing a machine's results, so a partial report cannot appear complete. Jev result decisions are still off while their accuracy and rollout safeguards are tested.

## Summary of New Capabilities

- See whether the pool result report includes all expected machines.
- See a persistent incomplete-coverage signal after a result journal is lost.

## Evidence

Focused store, API, and lifecycle tests cover absent and revoked machines, malformed membership, and journal loss across restarts.

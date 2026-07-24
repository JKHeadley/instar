# Mesh hand-back rope-health wiring

## What Changed

Preferred-captain hand-back now reads the real per-rope mesh health snapshot. Previously, production never registered that snapshot with the hand-back reconciler, so a healthy preferred machine remained permanently “unknown” even though synthetic tests passed.

## What to Tell Your User

When your agent runs on a stationary machine and a traveling laptop, this closes the production wiring gap that prevented serving from returning to the preferred machine. The health check uses fresh authenticated mesh traffic and refuses to transfer when reachability has not been observed. A real two-machine failover and return drill remains the release acceptance gate.

## Summary of New Capabilities

- Connects the production mesh resolver’s health snapshot to preferred-captain hand-back.
- Distinguishes never-observed ropes from observed healthy and observed dead ropes.
- Preserves fail-closed behavior when health evidence is absent.

## Evidence

The focused hand-back suite passes 27 tests, including never-observed, healthy, dead, throwing-provider, and missing-provider boundaries. The full TypeScript build passes.

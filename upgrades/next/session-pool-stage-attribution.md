# Session-pool stage attribution

## What Changed

Failover checks now credit their result to the currently active session-pool
stage using the same live stage source as the promotion controller. Installed
package version is used as the build identity when Git metadata is unavailable.

## What to Tell Your User

Multi-machine failover rollout can now keep climbing after a successful check
instead of getting stuck because the proof was attached to an earlier rollout
stage. The safety gates are unchanged: only a green for the active stage and
running build can unlock the next step.

## Summary of New Capabilities

- Current-stage attribution for live failover evidence.
- Stable package-version identity on installations without Git metadata.
- Boundary protection that rejects proof attached to the wrong stage.

## Evidence

- tests/unit/session-pool-failover-runner-wiring.test.ts
- tests/unit/StageAdvancer.test.ts

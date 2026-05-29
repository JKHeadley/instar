# Side effects — Track H part 3: load-rebalance planner (§L4 Stage-3, dark)

## What this adds
`src/core/RebalancePlanner.ts` — the pure Stage-3 load-rebalance decision. `planRebalance(input, placementExecutor)` proposes a BOUNDED set of transfers off over-saturated machines (session ratio > rebalanceThresholdPercent), only for non-pinned, low-priority, off-cooldown sessions; at most one move per source per cycle (cascade guard); the target is chosen by the same PlacementExecutor.decide(reason:'rebalance') the router uses; a working copy of capacities is updated as moves are proposed so it never piles onto one target. No qualifying session ⇒ no move.

## Risk / blast radius
None — pure function, not wired into a tick yet. The caller (a heartbeat-interval rebalance tick, post-activation) performs the actual transfers via TransferOrchestrator. Evaluated ONLY on the heartbeat interval by design, never per message.

## Tests
- `tests/unit/RebalancePlanner.test.ts` — 8: moves off-saturated→free; no-move-under-threshold; never moves pinned/hard-pinned; never moves within cooldown; never moves a non-low-priority/critical session; one-move-per-source cascade cap; distinct-sessions across sources; purity.

## Follow-ups (Track H — the remaining frontier)
The heartbeat rebalance tick that drives planRebalance → TransferOrchestrator; the live-ingress interception + outbound mesh client (D11 activation); real-hardware (laptop+mini) + test-as-self nickname-swap proof.

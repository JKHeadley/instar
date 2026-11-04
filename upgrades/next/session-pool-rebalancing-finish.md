<!-- bump: patch -->

## What Changed

Load-driven moves between machines now work and have a real on-switch. Peers' session limits reach the capacity row, which is what Overload shed checks, so it can find a target at all. It picks only conversations with a running session that has sat quiet for 10 minutes, on a machine at 85% or more of its session limit, and moves them through the same drain as a manual transfer. Pool stage `rebalance` is now the gate: it needs a fresh proof from `POST /session-pool/rebalance-proof`, kept in its own signed store, and steps down if that proof is red or over 30 days old. Failover test runs no longer count toward stage 3.

Peer session numbers also feed placement scoring for new conversations, at every stage.

## What to Tell Your User

If you run me on several machines, a machine that runs short of session slots can hand a quiet conversation to another machine by itself. This stays off until each machine has proved it can do it, and it frees slots and memory, not CPU.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Rebalance proof | `POST /session-pool/rebalance-proof` with `{ topic, to }`, then `GET /session-pool/rebalance-proof/RUN_ID` |
| Proof topics | `multiMachine.sessionPool.rebalanceProofTopics` |

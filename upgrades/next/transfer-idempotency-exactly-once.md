<!-- bump: patch -->

## What Changed

Two fixes for the 2026-06-05 "move this to the laptop" noise incident, where
one user message produced contradictory "Moving to Laptop" / "I can't move
this right now (rate-limited)" replies and executed multiple times.

1. **Idempotent topic transfer.** The transfer planner now recognizes a move
   request targeting the machine the topic is already on — or already pinned
   to — BEFORE the rate limit. Duplicates of an already-satisfied move answer
   "This conversation is already running on X — nothing to move" instead of a
   rate-limit rejection. The rate limit keeps its real job: damping rapid
   flip-flops between DIFFERENT machines.

2. **Exactly-once ingress turns on with the pool.** The exactly-once inbound
   message gate (the dedupe ledger that stops retried/replayed messages from
   re-executing commands) shipped default-OFF — even on machines whose
   multi-machine session pool was live. The default is now stage-aware: a pool
   at `live-transfer` or `rebalance` gets `exactlyOnceIngress` ON
   automatically. An explicit `multiMachine.exactlyOnceIngress: false` still
   wins.

## What to Tell Your User

Asking me to move a conversation to a machine it's already on (or repeating
the request) now gets a calm "already running there" instead of a confusing
"rate-limited" error. And if my internals retry a message under load, the
command runs once — not four times.

## Summary of New Capabilities

- Duplicate "move to X" requests no-op as "already there" — never "rate-limited."
- The transfer planner accepts an optional `currentPinOf` hook (pin-aware idempotency).
- `exactlyOnceIngress` defaults ON whenever the session pool routes real traffic.

## Evidence

`tests/unit/TransferByNickname.test.ts` (+5, including the verbatim incident
case: already-on-target inside the rate window → noop) and
`tests/unit/seamlessnessConfig.test.ts` (+4, stage coupling both ways +
explicit-override both ways). tsc + lint clean. Production logs
(2026-06-05T04:20Z double pin, zero `exactly-once` lines on a live-transfer
pool) are the incident evidence.

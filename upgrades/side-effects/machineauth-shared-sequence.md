# Side-Effects Review — machineAuth shared monotonic sequence

**Version / slug:** `machineauth-shared-sequence`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`signRequest` (the single function every machineAuth-signed outbound request flows
through) now assigns the X-Sequence from a process-global monotonic counter
(`nextMachineAuthSequence()`, seeded from `Date.now()`) instead of the per-caller
`sequence` argument (now ignored). Fixes the cross-transport replay collision: the
receiver tracks one monotonic sequence per sending machine, but each channel had
its own `Date.now()`-seeded counter, so a lower-seeded channel (the lease
broadcast) was rejected as out-of-order forever.

## Decision-point inventory

1. **signRequest sequence source** → always `nextMachineAuthSequence()` (global,
   monotonic), regardless of the passed arg.

## 1. Over-block

**What legitimate inputs does this reject?** None — it makes MORE requests succeed.
Previously-rejected legitimate lease broadcasts now pass. The receiver's replay
defenses are unchanged: nonce uniqueness + 30s timestamp window + per-machine
monotonic sequence all still run. A genuine replay (reused nonce, or stale
timestamp, or a sequence below the watermark) is still rejected exactly as before.

## 2. Under-block

**What does this still miss?** Nothing new. Anti-replay strength is unchanged; the
fix only makes a single sender's many channels share one monotonic sequence
(which is what the per-machine watermark always assumed). Cross-MACHINE replay is
still caught (each machine has its own watermark on the receiver).

## 3. Blast radius

- `signRequest` is used by every machineAuth sender: lease broadcast, heartbeat,
  handoff, reply-marker, live-tail, MessageRouter relay, and the `instar pair`/
  handoff CLI. ALL now share the global counter — this is the intended fix (the
  chokepoint guarantees no caller can bypass it).
- The per-caller sequence counters in server.ts / MessageRouter become inert
  (their value is ignored); left in place to minimize churn — harmless dead args.
- Tests: `machine-auth.test.ts` (21) updated to the new contract + a regression
  for the interleaved-channel monotonicity + a direct NonceStore stale-rejection
  test. `machine-routes.test.ts` integration (23) green. tsc + lint clean.

## 4. Rollback

Pure code (no migration/config/schema). Rollback = revert the PR. The sequence
reverts to per-caller, re-introducing the collision (so don't revert without
re-introducing bug #3).

## 5. Failure modes

- Process restart → counter re-seeds from the new (higher) `Date.now()`, still
  above any prior watermark. Monotonic across restarts by construction.
- Concurrency → single-threaded JS; `nextMachineAuthSequence` increments atomically.

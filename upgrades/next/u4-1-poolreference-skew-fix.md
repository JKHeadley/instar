# Pin fold skew gate: wire the pool-relative reference (quiet streams no longer false-quarantine honest records)

<!-- bump: patch -->

## What Changed

Fixes fb-1d51e996-0a3 (live-reproduced 2026-07-02). PR #1332's U4.1 pin fold
(`TopicPinFoldView`) skew-gates every replicated `topic-pin-record` HLC through
`HybridLogicalClock.receive(hlc, {poolReference})` — but nothing supplied the
`poolReference` dep. `receive()` deliberately references
`max(last.physical, poolReference ?? 0)` and never the bare local `now()`
(foundation spec §3.4), so a QUIET fold clock's reference froze at its
construction seed (server boot). Pins are rare operator events, so the stream is
almost always quiet: any honest pin record authored more than `maxDriftMs`
(default 5min) after the receiver's last acceptance was falsely quarantined as
"skew-ahead" — STICKILY, by design — killing pin replication between
long-running servers (and even author-side: a machine quarantined its OWN fresh
PUT after a peer bounce).

The fix, per the converged u4-1 spec's §2C gate composed with foundation §3.4:

- New `poolReferenceFromCapacities()` export — `max(now, freshest clock-OK peer
  heartbeat self-stamp)`; peers the registry's skew FSM distrusts never raise
  the floor; single-machine → now alone.
- `TopicPinFoldView.refresh()` floors the reference at its own `now()` on every
  fold regardless of wiring (a future unwired construction site can never
  re-freeze the gate), and passes the moving reference on every `receive()`.
- `src/commands/server.ts` wires the dep at the single production construction
  site from `machinePoolRegistry.getCapacities()`.
- `status().skewReference` (additive) exposes the live gate floor on
  `GET /pool/pin-quarantine` for diagnosability.

The sticky quarantine is NOT weakened: existing false-positive entries clear via
`pruneSuperseded` on the next accepted PUT/tombstone or the explicit readmit
route; a genuinely future-skewed record (beyond `maxDriftMs` of the MOVING pool
reference) is still rejected, stickily quarantined, and escalated.

## What to Tell Your User

<!-- audience: user, maturity: preview -->
- **Machine pins now stick reliably**: when you pin a conversation to a specific
  machine ("run this on the mini"), that choice now replicates dependably
  between your machines even after they have been running quietly for a long
  time. Previously a long-running machine could wrongly treat a fresh pin or
  unpin from another machine as suspicious and ignore it; that misjudgment is
  fixed, and the protection against genuinely wrong clocks is unchanged.

## Summary of New Capabilities

None — a correctness fix to the existing U4.1 pin-persistence machinery, plus a
diagnostic field on an existing read surface.

## Evidence

Live reproduction, 2026-07-02 (two machines, Laptop + Mini):

- The Laptop quarantined the Mini's honest unpin tombstone:
  `[TopicPinFoldView] skew-quarantined pin record key=30223 origin=m_4cbc0d4a0c… (physical 1783012672666 > reference 1783009909639 + 300000ms)` —
  the reference (16:31:49Z) was the Laptop server's BOOT time, 46 minutes stale
  against the record's honest 17:17:52Z author time.
- After a Laptop bounce, the Mini's fold quarantined its OWN freshly-authored
  PUT: `(physical 1783013064633 > reference 1783012686688 + 300000ms)` — its own
  fold clock frozen at ITS boot.
- Control: with a freshly-booted receiver (reference near now), the SAME record
  was ACCEPTED and the full transfer actuated in ~90s — isolating the defect to
  reference sourcing; the rest of the pipeline is correct.

After the fix, the new regression suite models exactly those traces (a record
authored 46min after the fold-clock seed on a quiet stream) and it is accepted;
a stash-revert run proves the 9 new tests fail on the pre-fix code while all 25
pre-existing u41 tests still pass. Full u41 family (unit + integration + e2e):
52/52 green.

<!-- bump: minor -->

## What Changed

**Coherence Journal mesh transport (P1 closing step)** — the `journal-sync`
MeshCommand + receive handler + own-stream advert on the `session-status`
response + `PeerPresencePuller` delta-drive that runs the merged
`JournalSyncApplier` over the existing 30s machine check-in
(COHERENCE-JOURNAL-SPEC §3.4 rule 5). Adverts are O(kinds) integers on the
heartbeat; entry deltas ride separate size-capped requests. Ships DARK
everywhere (gated on explicit `multiMachine.coherenceJournal.replication.enabled
=== true`) — merge does not change live mesh traffic; cross-machine sync is
a deliberate flip (the live two-machine proof).

## What to Tell Your User

This is the wire that lets your agent's machines actually exchange their
diaries — but it ships switched OFF. Turning it on (so the Laptop can answer
"where did this conversation live on the Mini?") is a deliberate, watched
step, not something a code update flips silently.

## Summary of New Capabilities

- None user-invocable yet — the transport is dark until the replication
  switch is turned on. Internal: `journal-sync` mesh verb + advert-driven
  delta replication.

## Evidence

- Integration round-trip (two in-process journal+applier pairs through a
  real signed MeshRpc envelope; forged-sender rejection) + gated-drive unit
  test (no-op when off, never throws). tsc + full lint chain clean.

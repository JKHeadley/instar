<!-- bump: minor -->

## What Changed

**Coherence Journal P1.3 (apply/serve engine)** — `JournalSyncApplier`,
the pure mesh-independent receive+serve engine for journal replication
(COHERENCE-JOURNAL-SPEC §3.4): first-hop sender binding, schema-validated
apply with suspect-self-clear, incarnation-fenced restore detection with
bounded quarantine, truncation gap signals, ack-after-fdatasync on receive,
and durably-flushed-only own-stream serve. The `journal-sync` mesh verb +
session-status advert + the live two-machine proof are the closing wiring
step (the engine ships ahead of the network exposure, fully tested).

## What to Tell Your User

Nothing user-visible changes yet — this is the engine that will let your
agent's machines safely exchange their diaries. Once the final wiring lands,
asking ANY machine "where did this conversation live / where are the
overnight files?" will answer from a synced history. Today the engine is in
place and proven; the cross-machine exchange turns on with the next step.

## Summary of New Capabilities

- None user-invocable yet (the engine is internal; the `journal-sync`
  transport that drives it is the closing wiring step). Internal:
  `JournalSyncApplier` (receive+serve engine for §3.4 replication).

## Evidence

- 26 new tests covering every §3.4 rule (seq-gating, forged-entry reject,
  suspect→self-clear, incarnation quarantine bounds + reset-flapping,
  truncation fast-forward, ack-after-fsync ordering via injected spy,
  guardWrite refusal). tsc + full lint chain clean.

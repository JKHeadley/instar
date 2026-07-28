# Side-Effects Review — Coherence Journal mesh transport (P1 closing step)

**Version / slug:** `coherence-journal-meshwire`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required as a PR-time pass — design converged (§3.4 rule 5); this is the transport that drives the already-merged, already-reviewed JournalSyncApplier`

## Summary of the change

Wires the `journal-sync` mesh transport (COHERENCE-JOURNAL-SPEC §3.4 rule 5) that drives the merged `JournalSyncApplier`: a `journal-sync` MeshCommand (read/observe RBAC class), an always-registered receive handler (serve own-stream batch / apply inbound), the own-stream advert piggybacked on the `session-status` response, and the `PeerPresencePuller` delta-drive (request + apply when a peer is ahead). The SEND/drive path is gated on `multiMachine.coherenceJournal.replication.enabled === true` (explicit true only) — ships DARK on every agent including echo; merge does not alter live mesh traffic.

## Decision-point inventory
- `journal-sync` RBAC classification — ADD — read/observe class (any registered peer), same as capacity-report/session-status. No new authority: it serves/accepts replica DATA, never an actuation.
- Replication activation — gated on explicit `replication.enabled===true`; absent in ConfigDefaults → false everywhere. The proof flips it deliberately.

## 1. Over-block
Receive handler rejects forged/invalid entries via the applier's §3.4 gates (already reviewed) — counted, never silent. No new over-block surface on the live path (drive is dark).

## 2. Under-block
First-hop-only: a third machine's history relayed by a peer is rejected (accepted P1 limitation; transitive relay is post-P1). The receive handler being always-on is safe because the applier validates every entry and no peer SENDS unless its own replication flag is on.

## 3. Level-of-abstraction fit
Transport is a thin driver over the pure applier/writer; the puller carries the advert because the puller IS the existing 30s cadence (no new timer — §3.4 rule 5's grounded correction). Right seam.

## 4. Signal vs authority compliance
**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)
- [x] No — the transport moves signal data (replica streams). The §3.9 actuation-ban lint (merged) keeps consumers signal-only.

## 5. Interactions
- Heartbeat bloat: the advert is O(kinds) integers on the session-status RESPONSE; entry payloads ride SEPARATE size-capped journal-sync requests, never the heartbeat envelope (the master spec's JSON.stringify-on-hot-path root cause is avoided).
- Mixed-version: an old peer RBAC-default-denies journal-sync (403) or has no handler (501); the sender treats both as "peer lacks the verb" and backs off — no retry storm (gated drive only runs when replication is on anyway).
- Backward-compat: the journalAdvert field on session-status is optional; old callers parse permissively and ignore it (verified).
- guardWrite seam: replica appends go through state.guardJournalWrite (standby-safe, prefix-allowlisted) — same as the writer.

## 6. External surfaces
- New mesh verb on the wire ONLY when replication.enabled===true on the sender. On merge: dark everywhere → zero new mesh traffic. The receive handler accepts journal-sync if a peer ever sends, but no peer sends while dark.
- New replica files under state/coherence-journal/peers/ ONLY once the proof flips it on.

## 7. Rollback cost
Pure code revert + patch; replica files inert plain JSONL. The dark default means rollback before the proof is a no-op in practice.

## Conclusion
The transport lands dark by explicit gate so merge ≠ live mesh change; the live two-machine proof is a deliberate, monitored flip (pre-approved). The §3.4-rule-5 grounded transport (advert on the real 30s pull, deltas separate + capped) is implemented as specified. After a successful proof, the gate can move to the spec's live-on-dev default in a follow-up. Clear to ship dark.

## Second-pass review (if required)
**Reviewer:** convergence panel (§3.4 design-time) + the live two-machine proof as the closing functional verification.

## Evidence pointers
- tests/integration/journal-sync-roundtrip.test.ts (two in-process pairs through a real signed envelope; forged-sender rejection), tests/unit/PeerPresencePuller-journal.test.ts (gated drive; no-op when off; never throws).

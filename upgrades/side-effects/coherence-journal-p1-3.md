# Side-Effects Review — Coherence Journal P1.3 (replication apply/serve engine)

**Version / slug:** `coherence-journal-p1-3`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `not required as a PR-time pass — design converged in the 4-round spec review; this is the §3.4 engine, mesh-independent and pure`

## Summary of the change

`JournalSyncApplier` — the RECEIVE + own-stream SERVE engine for journal replication, implementing COHERENCE-JOURNAL-SPEC §3.4 rules 1-4 as a pure module (no mesh/server dependency; the mesh wiring is the closing step). `apply(senderMachineId, batch)`: first-hop sender binding (entry.machine===sender or reject+count; replica path derived from sender, never payload), schema-validated apply (size/seq/ts/kind/typed-data; failure→suspect+stop, self-clear after K=20), incarnation fencing (new incarnation→quarantine ≤2 + coalesced divergence signal + reset-flapping past 3), truncation signals (oldestRetainedSeq→gap sentinel+fast-forward+gapped). `buildServeBatch`: own-stream, durably-flushed-only (reads the file), byte-capped, oldestRetainedSeq after rotation. Ack-after-fdatasync on the receive side (§4.1). Plus `getAdvertState`/`getStreamStatus`/`getDegradation`.

## Decision-point inventory

- The applier is pure logic with NO runtime actuation surface — it appends replica files and reports status. It makes no kill/spawn/place/transfer decision. Per §3.9, replica data it writes is read-only signal; the actuation-ban lint (shipped P1.2) guarantees no actuator imports the reader that serves it.

## 1. Over-block
The validation can reject a legitimate entry only if it genuinely violates seq-order/schema/sender-binding — each is the spec's required gate, and a rejection is counted + surfaced (suspect/forgedEntries), never silent.

## 2. Under-block
First-hop-only means a 3rd machine's genuine history that arrives via a relay is rejected — accepted P1 limitation (transitive relay needs per-entry signatures, explicitly out of P1). Documented.

## 3. Level-of-abstraction fit
Pure engine, mesh-injected by the caller — the right seam: it is unit-testable without a two-machine setup (26 tests prove every §3.4 rule deterministically), and the network layer can't smuggle logic past it.

## 4. Signal vs authority compliance
**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)
- [x] No — the applier writes signal data (replica streams); it holds no block/allow authority. The §3.9 actuation ban (lint, P1.2) keeps it signal-only structurally.

## 5. Interactions
- Writes replica files + `peers/<machine>.meta.json` that `CoherenceJournalReader` already reads (incarnation top-level, per-kind lastHeldSeq/status) — verified shape-compatible.
- Quarantine eviction routes through `SafeFsExecutor.safeRmSync` (destructive-fs funnel) — not raw unlink.
- Ack-after-fsync: an fsync failure reports 0 applied and does NOT advance lastHeldSeq (no false-durable claim that could desync a peer).
- guardWrite refusal (standby/prefix) → batch skipped + counted, never thrown.

## 6. External surfaces
- No route, no mesh verb yet (this is the engine; the `journal-sync` verb + session-status advert ride the closing wiring step). No external surface change in THIS PR beyond new replica files under `state/coherence-journal/peers/` when the engine is eventually driven.

## 7. Rollback cost
Pure code revert + patch. Replica files are inert plain JSONL. No migration.

## Conclusion
The §3.4 trust model — the load-bearing reason replication can't become a new incoherence source — is implemented as deterministic, fault-injected-tested code ahead of any network exposure. Recorded deviations: forged entries reject+count without marking suspect (rule 1 = trust violation, distinct from rule 2 torn-write); buildServeBatch takes explicit ownMachineId (keeps the module symmetric/pure); incarnation is a per-stream-set token (reconciles the prompt phrasing to the spec). Clear to ship as the engine; the wiring + live two-machine proof is the closing step.

## Second-pass review (if required)
**Reviewer:** convergence panel (design-time §3.4)
**Independent read of the artifact:** PR CI + the live two-machine proof (approved) as the closing verification.

## Evidence pointers
- `tests/unit/JournalSyncApplier.test.ts` (26) — every §3.4 rule incl. ack-after-fsync ordering (injected fs spy), guardWrite refusal, quarantine bounds.

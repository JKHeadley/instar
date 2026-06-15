---
title: "WS2 Send-Side Emission — wire the journal-backed replicated-record emitter (close the receive-only gap)"
slug: "ws2-send-side-emission"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "WS2-SEND-SIDE-EMISSION-SPEC.eli16.md"
status: "converged"
review-convergence: "2026-06-15T09:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-06-15T09:00:00.000Z"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481: multi-machine memory-replication headline; #1167 fixed the advert, this makes records cross. Decoupled build brief: .worktrees/echo-ws2-emission/BUILD-BRIEF.md"
parent-spec: "docs/specs/multi-machine-replicated-store-foundation.md (the WS2 substrate — this implements the step-3 SEND consumer left unbuilt there); docs/specs/ws22-learnings-replication.md (the learnings kind this wires end-to-end)"
lessons-engaged:
  - "Structure > Willpower: emission is a journal-backed EMITTER attached at one wiring chokepoint, not a per-store willpower hook; the wiring-integrity ratchet makes a future receive-only kind a CI failure, not a memory item."
  - "L15 Authorization: reach ≠ authority — a received peer record is read through the no-clobber union (append-both-and-flag for high-impact); a replicated record never clobbers a divergent local one. The emitter only emits THIS machine's own records (single-origin)."
  - "P4 Testing Integrity: three tiers + the E2E two-instance round-trip (a learning written on A is readable on B) + the wiring-integrity ratchet (every registered kind that is send-enabled has an emit path)."
  - "Distrust Temporary Success: the live gap shipped GREEN as substrate (registry + receive machinery + advert) with the SEND half a no-op stub — wiring-only/passing-unit-tests is not proof; only the cross-instance E2E is."
  - "Phase C: design holds for N machines — single-origin emission, content-fingerprint recordKeys, per-store bounds independent of pool size."
dependency-gate:
  blocks: "Reuses the MERGED WS2 generic substrate (HLC, CoherenceJournal kinds, ReplicatedRecordEnvelope, JournalSyncApplier tail transport, StoreSnapshot engine, UnionReader, ReplicatedStoreReader, ConflictStore, RollbackUnmerge) AND #1167 (the receive-advert fix)."
  status: "SATISFIED — verified 2026-06-15: all 7 *-record kinds present in CoherenceJournal.JOURNAL_KINDS and registered in replicatedKindRegistry (server.ts); #1167 merged @ 40f484a31 (v1.3.570)."
  enforcement: "The wiring-integrity ratchet asserts every send-enabled registered kind has a constructed emitter; the dual-registry coupling test (pre-existing) asserts each kind in BOTH registries."
cross-model-review: "internal multi-angle (the 5 adversarial lenses exercised in tests); external codex/gemini passes not run in the decoupled headless loop — the design is inherited from the already-converged foundation spec (this implements its step-3 consumer), and every decision below is grounded line-by-line in the merged substrate."
tracked-next-work: "WS2-SEND-2 wires the remaining seamed stores (relationships, knowledge, userRegistry, evolutionActions) onto the SAME emitter table; WS2-SEND-3 adds the preferences manager emit seam (it currently has none) + topicOperator delete-emission; WS2-SEND-4 wires the snapshot-pull bootstrap caller (state-snapshot client + applySnapshotCutover) so a long-dark machine bootstraps without a from-genesis tail. Each is enumerated in src/core/ws2SendWiring.ts (the wiring-integrity ratchet)."
---

# WS2 Send-Side Emission

## 1. The gap (root-caused LIVE on Laptop↔Mac-Mini, 2026-06-15)

After #1167 the receive-advert is correct (each machine reports the peer's
`stateSyncReceive` = 7). But a learning written on the Laptop never appears on the
Mini. The Laptop's coherence-journal META lists only the 5 pre-existing lifecycle
kinds — **none of the 7 WS2 `*-record` kinds**. WS2 records are never written to the
journal own-streams, so a peer has nothing to pull.

WS2 shipped as SUBSTRATE (kind registry + receive/apply machinery + advert) with the
SEND half unimplemented. The precise stub: in `src/commands/server.ts` the
`StoreSnapshotEngine` is constructed with `loadOwnEntries: () => ({})`, and — the
deeper cause — the per-store managers ALREADY call an internal `emitPut`/`emitDelete`
replication hook on every write (`EvolutionManager.saveLearnings`,
`RelationshipManager.save`, `KnowledgeManager.ingest`, `UserManager.persistUsers`, …),
but server.ts never constructs the concrete journal-backed emitter those hooks call —
two sites explicitly defer it ("the journal-backed emitter is attached in a later
rollout stage", server.ts:8483, 8532). The hooks fire into a `null` emitter (no-op),
so nothing is ever appended to a `*-record` stream.

## 2. What already exists (do NOT reinvent)

- **The per-store emit call sites** — every memory manager already invokes
  `emitter.emitPut(record)` / `emitter.emitDelete(...)` at its real write/delete
  funnel, behind a `*ReplicationEmitter | null` seam (a setter or constructor arg).
  The call sites are DONE; the emitter implementation and its injection are missing.
- **The per-store record builders** — `buildLearningRecordData` /
  `buildLearningTombstoneData` / `deriveLearningRecordKey` (LearningsReplicatedStore),
  and the exact analogs for the other six stores. They produce the disclosure-minimized,
  byte-capped, type-clamped envelope `data`. DONE.
- **The generic envelope + validator** — `validateReplicatedEnvelope` +
  `ReplicatedKindRegistry` (ReplicatedRecordEnvelope.ts). DONE.
- **The journal tail transport** — `CoherenceJournal` (per-kind append-only streams,
  own-advert over `JOURNAL_KINDS`), `JournalSyncApplier` (first-hop-bound receive →
  `peers/<M>.<kind>.jsonl`, seq-contiguous, incarnation-fenced), and the
  receiver-driven `PeerPresencePuller.driveJournalDelta` which ALREADY pulls EVERY
  kind in a peer's advert (no kind allowlist) — so it will pull the new `*-record`
  streams the instant they exist. DONE.
- **The no-clobber read** — `UnionReader.readUnion` (HLC-max + last-writer-witness
  concurrency detector → append-both-and-flag), `ReplicatedStoreReader` (the
  bypass-proof funnel). DONE; its `loadOriginRecords` seam currently returns only the
  OWN origin.

## 3. The four generic gaps (what this PR builds)

All four are KIND-AGNOSTIC — built once, they serve every registered replicated kind;
the only per-store work is one small adapter that maps the manager's emit signature to
the store's `build*RecordData` (a table row).

### 3.1 The journal cannot append/validate a `*-record` kind
`CoherenceJournal.validate()` is a hardcoded switch over the 5 lifecycle kinds; any
`*-record` kind falls through to `return null` (schema-reject). And there is no public
method to append a replicated record.

**Fix.** Inject the `ReplicatedKindRegistry` into the journal (a setter, optional —
absent ⇒ unchanged behavior). Add `emitReplicatedRecord(kind, data)`: a public,
non-blocking emit that (a) requires a registered replicated kind, (b) validates via
`validateReplicatedEnvelope(data, schema, counters)`, (c) derives the op-key from
`recordKey + ':' + serializeHlcKey(hlc)` (idempotent on the exact logical event — a
retry of the same put/delete dedupes; a new HLC is a new event), and (d) enqueues like
any other emit. `validate()` gains ONE branch: a registered replicated kind delegates
to `validateReplicatedEnvelope`; everything else is unchanged. The per-entry byte cap
becomes per-kind (`*-record` → 64 KB, the `LEARNING_MAX_ENTRY_BYTES` class; lifecycle
kinds → the unchanged 8 KB) so a fat-but-legal learning is not dropped as oversize.

### 3.2 The applier rejects a `*-record` kind on receive
`JournalSyncApplier.validateData()` mirrors the same hardcoded switch → a peer's
`learning-record` entry is marked `invalid`, suspect-flags the stream, stops the batch.

**Fix.** Inject the SAME registry (optional). `validateData(kind, data)` delegates a
registered replicated kind to `validateReplicatedEnvelope`; the per-entry size cap is
per-kind (matching §3.1). Everything else (first-hop binding, seq-contiguity,
incarnation fencing, durable-before-ack) is unchanged — the record kinds ride the
existing tail transport verbatim.

### 3.3 The union read sees only the OWN origin
`ReplicatedStoreReader.loadOriginRecords` returns one OWN record; a peer's replica in
`peers/<M>.<kind>.jsonl` is never materialized, so even a correctly-received record is
invisible to a read.

**Fix.** A new pure-ish reader, `ReplicatedPeerStreamReader`, materializes the union's
per-origin records from the journal streams on disk: it reads the OWN stream
(`<self>.<kind>.jsonl` + archives) AND every peer stream (`peers/<M>.<kind>.jsonl` +
archives), validates each line via `validateReplicatedEnvelope` + the store schema,
and folds to the LATEST record per `(origin, recordKey)` by HLC-max (a delete is a
tombstone, kept). It exposes `loadOriginRecords(store, recordKey)` and
`listRecordKeys(store)` — exactly the `ReplicatedStoreReader` seams. The own origin is
now journal-sourced (its authoritative emit-time HLC), so own + peer share one merge
order. A `learnings` union reader is wired through this for the slice.

### 3.4 `loadOwnEntries` is a no-op stub
The snapshot-serve path returns no entries, so a recovering peer that pulls a snapshot
gets nothing (it still falls back to the from-genesis tail — correctness-safe, just not
the bootstrap optimization).

**Fix.** Replace the stub with a loader that reads the OWN journal streams for every
registered kind that maps to the requested store, returning `entriesByKind`. This makes
`serveSnapshot` return real entries. (The snapshot-PULL caller — `applySnapshotCutover`
— remains tracked as WS2-SEND-4 <!-- tracked: WS2-SEND-4 -->; the ongoing tail already
replicates without it.)

## 4. The emitter (the new load-bearing piece)

`src/core/ReplicatedRecordEmitter.ts` — a generic, store-agnostic, journal-backed
emitter. Seams (DI'd, unit-testable): the journal's `emitReplicatedRecord`, a
`HybridLogicalClock`, the resolved `StateSyncStores` flags, this machine's `origin`
id, and `loadWitness(store, recordKey) => HlcTimestamp | undefined`.

On `put(store, recordKey, buildData)` / `delete(store, recordKey, buildTombstone)`:
1. **Dark gate** — `isStoreEmissionEnabled(stores, store)` false ⇒ strict no-op (the
   default; a single-machine or fleet agent emits nothing).
2. **Degenerate guard** — a null `recordKey` (no stable identity surface) ⇒ skip.
3. **Witness (the `observed` field, §7.2 of the foundation)** —
   `observed = loadWitness(store, recordKey)` = the MAX HLC over every origin record
   THIS machine currently holds on disk for that key (own prior + applied peers). This
   is SOUND by construction: it claims "sequential-after" only a version provably on
   disk; a not-yet-pulled peer version is simply absent ⇒ the pair flags concurrent
   (err-toward-flag, never a silent clobber). Absent (first write) ⇒ omitted.
4. **Tick** — `hlc = clock.tick()`. HLC monotonicity guarantees `hlc > observed`, so a
   reader sees this write as the later one in a clean sequential chain.
5. **Build + append** — `buildData(hlc, origin, observed)` (the store's
   `build*RecordData`); on null skip; else `journal.emitReplicatedRecord(kind, data)`.

Per-store glue (server.ts) is one adapter object per manager, e.g.:
```
evolution.setLearningReplicationEmitter({
  emitPut: (rec) => emitter.put('learnings',
     deriveLearningRecordKey(rec.title, rec.category, rec.source),
     (hlc, origin, observed) => buildLearningRecordData({ record: rec, hlc, origin, observed })),
  emitDelete: (title, category, source, deletedAt) => emitter.delete('learnings',
     deriveLearningRecordKey(title, category, source),
     (hlc, origin, observed) => buildLearningTombstoneData({ title, category, source, hlc, origin, deletedAt, observed })),
});
```
The emitter never throws into the manager (the manager's hooks are already try/wrapped);
a disabled store, a degenerate key, or a build-rejection is a counted no-op.

## 5. Decisions resolved (the brief's convergence questions)

- **emit-on-write vs periodic-scan → emit-on-write.** The manager call sites already
  exist and fire at the exact mutation funnel; a scan would duplicate the prune/upsert
  logic and lag. Coalescing of churn is the journal's per-kind rate cap, not a scan.
- **per-kind sync driver vs generic engine → generic.** `PeerPresencePuller.
  driveJournalDelta` already pulls every advertised kind, and `JournalSyncApplier`
  already applies any kind it can validate. Once §3.1–3.3 land, the existing tail
  transport replicates all 7 kinds with NO per-kind driver. `drivePreferencesSync`
  (the deprecated `preferences-sync` verb) is NOT extended — it is superseded by this
  foundation path.
- **ordering / incarnation → orthogonal.** Merge order is the record-level HLC (in
  `data`); stream fencing is the journal incarnation (in meta). An incarnation flip
  re-mints the stream but never resets HLC order (HLC is monotone across incarnations).
- **idempotency on recordKey → op-key = `recordKey:serializeHlcKey(hlc)`.** A retry of
  the identical logical event dedupes (the journal's restart-proof op-key index); a new
  HLC is a distinct event. On receive, seq-contiguity + the HLC-identity dedup net make
  re-apply idempotent.

## 6. Scope — the vertical slice (brief's SCOPE HONESTY clause)

This PR ships the COMPLETE generic machinery (§3, §4) and wires **learnings**
end-to-end with a passing two-instance E2E (a learning written on instance A is
readable on instance B). The other seamed stores (relationships, knowledge,
userRegistry, evolutionActions) are table rows on the SAME emitter and are wired in
WS2-SEND-2; preferences (no manager emit seam yet) + topicOperator (put-only) are
WS2-SEND-3. The wiring-integrity ratchet (§7) enumerates exactly which registered kinds
are send-wired vs send-pending, so a future kind cannot be silently added receive-only
again (the exact gap this fixes). Everything ships DARK behind
`multiMachine.stateSync.<store>.enabled` (default false; dev-agent gate live).

## 7. Test plan (three tiers + named invariants — NON-NEGOTIABLE)

- **Unit** (`tests/unit/ReplicatedRecordEmitter.test.ts`,
  `tests/unit/CoherenceJournal-record-emit.test.ts`,
  `tests/unit/ReplicatedPeerStreamReader.test.ts`):
  - emitter is a strict no-op when the store is disabled; emits the built record when
    enabled; omits `observed` on first write and supplies the prior HLC on a sequential
    re-write; skips a degenerate (null) recordKey.
  - `CoherenceJournal.emitReplicatedRecord` appends a `learning-record` line (validated,
    op-key deduped, 64 KB cap honored) and rejects an unregistered kind / a malformed
    envelope.
  - `ReplicatedPeerStreamReader` materializes own + peer streams to per-origin
    `OriginRecord`s, folds by HLC-max, keeps a tombstone, and lists record keys.
  - `loadOwnEntries` returns the own entries for a registered kind.
- **Integration** (`tests/integration/ws2-send-journal-roundtrip.test.ts`): a real
  `CoherenceJournal` + `JournalSyncApplier` — emit a learning on the writer →
  `buildServeBatch('learning-record', …)` returns it → `applier.apply(sender, batch)`
  durably writes the peer replica → `ReplicatedPeerStreamReader` on the receiver reads
  it back. Also: `StoreSnapshotEngine.serveSnapshot('learnings')` returns real entries.
- **E2E (the real proof)** (`tests/e2e/ws2-learnings-cross-instance.test.ts`): two
  in-process instances A and B with separate stateDirs. A's `EvolutionManager.addLearning`
  (emission enabled) → A's journal stream has the record → transfer A's own stream to B
  via the buildServeBatch→apply path (mirroring journal-sync-roundtrip) → B's `learnings`
  union read returns A's learning as a foreign origin record. This reproduces and closes
  the live gap.
- **Wiring-integrity ratchet** (`tests/integration/ws2-send-wiring.test.ts`): for every
  store registered in `replicatedKindRegistry`, assert it is either in the
  send-WIRED set (has a constructed emitter adapter) or the explicit send-PENDING
  allowlist — and assert `learnings` is WIRED. A new kind added with neither fails CI.

## 8. Safety, rollout, migration & awareness

- **Dark by default.** Emission is gated on `multiMachine.stateSync.<store>.enabled`
  (default false; the dev-agent gate flips it live on a dev agent only). No gate blocks
  a user action; the only refusals are at the receive door (validator) and the emit door
  (dark store) — both protect data.
- **Migration parity.** No new agent-installed files; the feature is server-internal and
  activates on the next restart of an agent whose stateSync stores are enabled. The
  CLAUDE.md template already documents stateSync; no template change required for the
  dark slice (awareness lands when a kind is flipped on for the fleet).
- **Bounds.** Per-kind retention + rate caps already exist in the journal's
  `DEFAULT_RETENTION`; the 64 KB per-entry cap for `*-record` kinds matches the store
  builders' `assertProjectionUnderCap`.

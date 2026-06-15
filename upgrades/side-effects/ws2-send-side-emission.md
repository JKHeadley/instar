# Side-Effects Review — WS2 send-side emission (wire the journal-backed replicated-record emitter)

**Spec:** docs/specs/WS2-SEND-SIDE-EMISSION-SPEC.md (converged + approved — operator pre-approval, Justin topic 13481, the multi-machine memory-replication headline). **Parent:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions.
**Ships DARK** behind `multiMachine.stateSync.<store>.enabled` (default false; the dev-agent gate flips it live on a dev agent only). Single-machine installs, and any agent with the stores off, are a strict no-op.
**Files:** src/core/ReplicatedRecordEmitter.ts (new), src/core/ReplicatedPeerStreamReader.ts (new), src/core/ws2SendWiring.ts (new), src/core/CoherenceJournal.ts, src/core/JournalSyncApplier.ts, src/commands/server.ts.

## What changed

1. **ReplicatedRecordEmitter.ts (new):** the generic, store-agnostic, journal-backed emitter the per-store managers' existing `emitPut`/`emitDelete` hooks call. One `emit(store, recordKey, build)` path: dark gate → degenerate-key guard → `observed` witness → HLC tick → store builder → `journal.emitReplicatedRecord`. Never throws into the manager (a builder/journal fault is a counted no-op). Single-origin by construction (stamps `origin = this machine`).
2. **ReplicatedPeerStreamReader.ts (new):** materializes the union's per-origin records from the OWN journal stream + every peer replica stream (`peers/<M>.<kind>.jsonl`, quarantine/meta excluded), validated through `validateReplicatedEnvelope` + the store schema, folded to the latest per (origin, recordKey) by HLC. Supplies three seams: `loadOriginRecords`/`listRecordKeys` (the union reader), `loadWitness` (the emitter's `observed` source), and `loadOwnEntries` (the snapshot-serve source — replaces the `() => ({})` stub).
3. **ws2SendWiring.ts (new):** the send-wiring manifest (WIRED vs PENDING stores) + the `auditWs2SendWiring` ratchet — every registered replicated kind must be consciously classified, so a future kind cannot be added receive-only with a silent no-op SEND half.
4. **CoherenceJournal.ts:** optional `setReplicatedKindRegistry`; new public `emitReplicatedRecord(kind, data)` (validates a registered `*-record` kind through the generic envelope validator, op-key = `recordKey:hlcKey`); the `validate()` switch gains ONE branch delegating a registered replicated kind to `validateReplicatedEnvelope`; the per-entry byte cap is per-kind (80 KB for `*-record` kinds, the 8 KB lifecycle cap unchanged). Absent registry ⇒ byte-identical prior behavior.
5. **JournalSyncApplier.ts:** optional `setReplicatedKindRegistry` (+ config option); `validateData()` delegates a registered replicated kind to `validateReplicatedEnvelope`; the per-entry size cap is per-kind (matching the writer). Without the registry a peer's `*-record` would `invalid`-flag the stream — the receive-only gap; with it, the record applies on the existing tail transport.
6. **server.ts:** constructs (when the coherence journal is live) the peer-stream reader + a persisted HLC clock + the generic emitter; injects the now-populated registry into BOTH the journal writer and the applier; replaces the `loadOwnEntries` stub with the reader; switches the `learnings` union reader to read own + peer journal streams; attaches the learnings emitter adapter to `EvolutionManager.setLearningReplicationEmitter`.

## Blast radius

- **Config-gated, not wiring-gated.** With `multiMachine.stateSync.learnings.enabled` false (the fleet default), the emitter is a strict no-op (the dark gate returns before any tick/append), so no `*-record` stream is ever written and the union read is byte-identical to today. The seams are always constructed (so the feature turns on without a restart-to-rewire) but do nothing until the store is enabled.
- **No new HTTP route, no new MeshRpc verb.** Records ride the EXISTING `journal-sync` tail (`buildServeBatch` serve + `apply` receive) and the EXISTING receiver-driven `PeerPresencePuller.driveJournalDelta` (which already pulls every advertised kind). The `state-snapshot` serve verb (already wired) now returns real entries via the real `loadOwnEntries`.
- **Single-origin + first-hop binding unchanged.** The emitter stamps `origin = this machine`; the applier's first-hop binding (`entry.machine === sender`) still rejects a forged cross-origin record. A peer's record lands only in its own `peers/<M>.<kind>.jsonl` namespace; the union read keeps origins separate and never writes a foreign record back into the local manager store (read-only union, no origin laundering).
- **No-clobber read.** A received record is read through the existing `ReplicatedStoreReader` + `UnionReader` (append-both-and-flag for high-impact); a replicated record never clobbers a divergent local one. The conflict ledger + dropped-origin exclusion are untouched.

## Risk + mitigation

- **Risk:** a replication emit fault breaks a local memory write. **Mitigation:** the emitter catches every builder/journal throw (counted in stats), and the managers' hooks were already try-wrapped — the durable local write is persisted before the emit hook runs. Proven by the "catches a builder/journal throw" unit tests.
- **Risk:** a wrong `observed` witness marks a genuinely-concurrent pair as sequential (a silent clobber). **Mitigation:** the witness is the MAX HLC over records PROVABLY on disk, read BEFORE the tick — it can only ever under-witness (a not-yet-pulled peer version is absent ⇒ the pair flags concurrent, the err-toward-flag safe direction). Proven by the witness-order unit test.
- **Risk:** a fat-but-legal learning is dropped as oversize. **Mitigation:** the per-entry byte cap is raised to 80 KB for `*-record` kinds on BOTH the writer and the applier (the store builders already cap `data` at 64 KB), so a record the writer emits is never rejected on receive. Proven by the 20 KB-description journal test.
- **Risk:** a future kind is added receive-only again (the exact original gap). **Mitigation:** the wiring-integrity ratchet (`auditWs2SendWiring`) fails CI if any registered store is neither send-wired nor explicitly send-pending.

## Migration parity

- No agent-installed files change. The feature is server-internal and activates on the next restart of an agent whose `multiMachine.stateSync.<store>` is enabled (the dev-agent gate decides for a dev agent). No `migrateConfig` / `migrateClaudeMd` / `migrateHooks` change is required for the dark slice; CLAUDE.md awareness lands when a kind is flipped on for the fleet (a later rollout step).

## Dark-gate line-map

- UNCHANGED. This PR adds no new `enabled:` line to `ConfigDefaults.ts` — the per-store stateSync flags already exist there (omitted `enabled`, resolved by the dev-agent gate, shipped in the WS2.x substrate PRs). The emitter reads the SAME resolved `_stateSyncStoresResolved` map. `node scripts/lint-dev-agent-dark-gate.js` stays clean.

## Rollback

- Revert the PR (or set `multiMachine.stateSync.learnings.enabled: false`). The emitter goes dark, no `*-record` streams are written, the union read returns to own-only/no-op, and any already-replicated peer replica files age out under the journal's per-kind retention. No durable migration to unwind.

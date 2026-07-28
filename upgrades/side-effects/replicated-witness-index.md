# Side-Effects Review — Replicated witness index

**Version / slug:** `replicated-witness-index`
**Date:** `2026-07-10`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change makes the replicated-store `loadWitness(store, recordKey)` path use a derived in-memory index instead of rematerializing journal streams on every emit. The index is built by `ReplicatedPeerStreamReader` from the authoritative own and peer journal streams, then incrementally updated from two post-durability observers: `CoherenceJournal` notifies after a replicated local batch is written and `fdatasync` has returned, and `JournalSyncApplier` notifies after a peer replica batch is written and `fdatasync` has returned.

The journal and replica files remain the only authority. The index is process memory only, can be rebuilt at any time, and is parity-checked against the legacy full-scan witness answer before it is trusted. If parity fails, `loadWitness` falls back to the legacy scan and logs a loud witness-index warning.

## Decision-point inventory

- `ReplicatedPeerStreamReader.rebuildWitnessIndex` — add — streams registered replicated journal files to build the derived `(store, recordKey) -> max HLC` map.
- `ReplicatedPeerStreamReader.loadWitness` — modify — serves the derived map when parity is trusted; falls back to the old scan if parity is not trusted.
- `ReplicatedPeerStreamReader.observeCommittedEntries` — add — folds durable local/peer append notifications into the derived map.
- `CoherenceJournal.setReplicatedRecordCommitObserver` / notification — add — notifies only after local replicated records have crossed the flush/fdatasync boundary.
- `JournalSyncApplier.setReplicatedRecordCommitObserver` / notification — add — notifies only after peer replica records have crossed the append/fdatasync boundary.
- `server.ts` WS2 wiring — modify — attaches the two observers to the one `ReplicatedPeerStreamReader`.

## 1. Over-block

No user operation is newly blocked. The witness index is a read optimization for the replicated-store send path. If the index is wrong, the parity guard disables trust in it and serves the old scan result. If an observer callback throws, journal/apply durability is preserved and the index remains rebuildable from disk.

## 2. Under-block

The main under-detection risk is a stale derived index missing a witness. That would make a later emit omit `observed`, which is the safe merge direction: peers flag possible concurrency instead of silently clobbering. Production wiring reduces that risk by updating the index after every local and peer durable append. Restart/loss rebuilds from the journal streams.

## 3. Level-of-abstraction fit

Correct layer. `ReplicatedPeerStreamReader` already owns the witness seam and knows the registry, own streams, peer streams, schema validation, and HLC ordering. The journal and applier only expose post-fsync observations; they do not own witness semantics and do not persist an index. This keeps the optimization store-agnostic and avoids per-store caches.

Claim-check note: `src/commands/server.ts` has several unrelated open PR claims in dashboard/update/messaging layers. This change touches only the WS2 replicated-store wiring block to attach observer callbacks. No sibling appears to own the witness-index layer.

## 4. Signal vs authority compliance

- [x] No new gate or authority surface.

The new callbacks are informational derived-index updates. They cannot approve, block, mutate user-visible state, or make the journal authoritative in a new way. The existing journal/applier durability contracts remain the authority.

## 5. Interactions

- **Local journal flush:** the observer fires after the replicated batch is written and synced, so queued in-memory emits are never witnessed as durable.
- **Peer replica apply:** the observer fires after durable replica append, matching the applier's ack-after-fsync contract.
- **Parity mode:** rebuild compares the index answer with the legacy full-scan witness answer. A mismatch logs once and falls back to the scan.
- **Crash/restart:** there is no persisted index to corrupt. A new reader rebuilds from own and peer streams.
- **Existing union reads:** `loadOriginRecords`, `listRecordKeys`, and `loadOwnEntries` keep their existing behavior. This PR narrows the optimization to the hot witness lookup.

## 6. External surfaces

No new API route, config key, dashboard control, CLI, or persistent schema. Runtime logs may include a new `[ws2-witness-index]` parity mismatch line if the derived index ever disagrees with the legacy scan.

## 6b. Operator-surface quality

No operator surface. The only operator-visible change should be reduced synchronous work during replicated-store emission.

## 7. Multi-machine posture

This is explicitly multi-machine shared infrastructure and affects every replicated store, including PII replicated stores. The index is store-agnostic and uses the same `ReplicatedKindRegistry` and `validateReplicatedEnvelope` path as the existing reader. It does not replicate additional fields, does not write a new file, and does not expose more data to peers. It only changes how the local machine finds the max HLC it has already durably observed.

## 8. Rollback cost

Low to moderate. Reverting restores the legacy scan path and removes the observer callbacks. Because the index is not persisted, rollback has no data migration and cannot strand state. The cost is performance regression back to synchronous scan-per-witness on large journals.

## Conclusion

The change closes the performance residual without changing merge semantics: same witness answer, derived in memory, built from streamed journal reads, updated only after durable appends, and backed by parity fallback. The blast radius is shared infra, so coverage includes unit, integration, and e2e lifecycle tests.

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required for this Tier-1 performance optimization with no new authority, no schema migration, and parity fallback.

## Evidence pointers

- `npx tsc --noEmit`
- `npx vitest run tests/unit/ReplicatedPeerStreamReader.test.ts tests/unit/ReplicatedRecordEmitter.test.ts tests/unit/evolution-manager-emit-wedge.test.ts tests/integration/replicated-witness-index.integration.test.ts tests/e2e/replicated-witness-index-lifecycle.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect. The recurring class was synchronous scan-per-emit after the #1414 emit-count fix. The closure is structural: witness lookup reads an O(1) derived map in the hot path, local/peer append sites update the map after fsync, and rebuild/parity keeps the journal authoritative.

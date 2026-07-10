# Replicated witness index

## What Changed

Replicated-store witness lookup now uses a derived in-memory index instead of scanning the journal streams on every emitted record. `ReplicatedPeerStreamReader` builds the index from own and peer replicated journal streams, then serves `loadWitness(store, recordKey)` from a `(store, recordKey) -> max HLC` map. `CoherenceJournal` and `JournalSyncApplier` update the index after replicated records are durably committed, so the index tracks fsynced bytes rather than queued writes.

The journal remains authoritative. The index is not persisted and rebuilds from disk on startup or loss. Rebuild includes parity mode: the derived witness answer is compared with the legacy full-scan answer, and any mismatch logs loudly and falls back to the scan.

## What to Tell Your User

- Multi-machine replicated-store writes should do much less synchronous journal work. A surviving emit no longer has to rescan a large replicated-store journal just to find the latest witness for one key.
- The optimization is conservative: it does not change merge rules, does not add a new data file, and does not make the index authoritative. If the derived answer ever disagrees with the legacy scan, Instar uses the old answer.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| O(1) replicated witness lookup | No operator action; replicated-store emitters use the indexed `loadWitness` path automatically |
| Derived witness index rebuild | Restart or index loss rebuilds from authoritative journal streams |
| Witness parity fallback | A mismatch between index and legacy scan logs and falls back to legacy scan |

## Evidence

- Unit: `tests/unit/ReplicatedPeerStreamReader.test.ts` covers index correctness across own/peer updates, no journal-byte reads during emitter witness lookup, and rebuild after in-memory loss.
- Integration: `tests/integration/replicated-witness-index.integration.test.ts` covers the real emitter path with a counted filesystem seam.
- E2E: `tests/e2e/replicated-witness-index-lifecycle.test.ts` rebuilds from own + peer journal streams and preserves the union read shape.
- Regression: `tests/unit/ReplicatedRecordEmitter.test.ts`, `tests/unit/evolution-manager-emit-wedge.test.ts`, and `npx tsc --noEmit` are green.

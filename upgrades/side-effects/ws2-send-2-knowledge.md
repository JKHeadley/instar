# Side-Effects Review — WS2-SEND-2: knowledge send-side replication

**Version / slug:** `ws2-send-2-knowledge`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no block/allow/lifecycle authority — additive, dark-gated data-replication wiring; see §4)

## Summary of the change

Extends WS2 send-side emission to the `knowledge` store (the second WS2-SEND-2 table-row store after `relationships`). Mirrors the proven pattern: `src/commands/server.ts` imports `buildKnowledgeRecordData` + `buildKnowledgeTombstoneData` and attaches the generic `ReplicatedRecordEmitter` to `KnowledgeManager.setKnowledgeReplicationEmitter` (replacing the prior `void` placeholder), gated `if (replicatedRecordEmitter)`; `src/core/ws2SendWiring.ts` moves `knowledge` PENDING→WIRED; a new e2e round-trip `tests/e2e/ws2-knowledge-cross-instance.test.ts`. The knowledge union reader already existed (constructed @8566). No decision-point surface added beyond the pre-existing dark gate.

## Decision-point inventory

- `ReplicatedRecordEmitter.emit` dark gate (`stateSync.knowledge.enabled`) — **pass-through** — pre-existing; `knowledge` is now a registered emit target. Default false ⇒ no-op.
- `KnowledgeManager.ingest`/`remove` emit funnel — **pass-through** — the manager already fires emitPut@165 / emitDelete@204; this attaches a real emitter where there was a no-op.
- `ws2SendWiring` ratchet — **modify** — `knowledge` reclassified PENDING→WIRED.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The emitter never rejects an ingest/remove; a null recordKey / null projection / over-cap source is a counted no-op and the local catalog write always succeeds.

## 2. Under-block

Not applicable (no block surface). A source with an empty identity anchor (no url AND no title) has no cross-machine fingerprint and is intentionally not replicated (by design) — local-only.

## 3. Level-of-abstraction fit

Correct layer. Table-row registration onto the generic #1168 substrate, exactly as the spec's WS2-SEND-2 prescribes. The disclosure-minimized projection lives in `KnowledgeReplicatedStore` alongside the receive-side schema.

## 4. Signal vs authority compliance

Compliant. No blocking authority. The emitter is additive/best-effort: a builder/journal failure is swallowed + counted, never propagated, so a knowledge ingest can never fail because replication did. The union read is advisory (HIGH tier append-both-and-flag). Per `docs/signal-vs-authority.md`, a replicator with no gate authority.

## 5. Interactions

- Shares `server.ts`'s single `replicatedRecordEmitter` + the existing `knowledgeUnionReader`. No double-fire: emitPut rides the single `ingest()` path, emitDelete the single `remove()` path. Distinct store key/kind from learnings + relationships.
- Touches the same `server.ts` + `ws2SendWiring.ts` as the other WS2-SEND stores → serialized (built on top of the merged #1169 relationships change; no parallel WS2-SEND PRs).

## 6. External surfaces

Dark by default (`multiMachine.stateSync.knowledge.enabled`). Off ⇒ byte-identical single-machine behavior. On (multi-machine, opt-in): only the catalog METADATA crosses (title, url, type, tags, summary, wordCount) — NEVER the markdown file BODY and NEVER the local id/filePath (fork #2). The peer LEARNS the source exists and may re-ingest locally; full-content sync is a separate tracked rollout stage. A received record is quoted `<replicated-untrusted-data>`, advisory reference only.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Path: `KnowledgeManager.ingest/remove` → `ReplicatedRecordEmitter.emit` → `CoherenceJournal.emitReplicatedRecord` → peer serve/apply → `ReplicatedPeerStreamReader.loadOriginRecords` → `knowledgeUnionReader` (no-clobber union, conflict-flagged). Identity = content fingerprint (url||title + type), so the same source on two machines collapses to one recordKey. remove() propagates a fingerprint-keyed tombstone (a later `delete` hlc wins over an earlier `put` — no resurrection). No user-facing notice surface; no topic-transfer state; no generated URLs.

## 8. Rollback cost

Trivial. Dark by default; affects only agents that enable `stateSync.knowledge`. Back-out = revert the three-file change or set the flag false (instant, no migration). Receive-side + envelope schema already shipped, unaffected.

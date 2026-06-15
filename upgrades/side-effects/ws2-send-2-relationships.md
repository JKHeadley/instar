# Side-Effects Review — WS2-SEND-2: relationships send-side replication

**Version / slug:** `ws2-send-2-relationships`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no block/allow/lifecycle authority — pure additive, dark-gated data-replication wiring; see §4)

## Summary of the change

Extends the WS2 send-side emission (proven end-to-end for `learnings` in #1168) to the `relationships` store — the first of the four "table-row" stores the WS2-SEND-SIDE-EMISSION-SPEC enumerates as WS2-SEND-2. Three edits, all mirroring the learnings slice: (1) `src/commands/server.ts` imports `buildRelationshipRecordData` + `buildRelationshipTombstoneData` and attaches the journal-backed `ReplicatedRecordEmitter` to `RelationshipManager.setReplicationEmitter` (emitPut/emitDelete → build\*RecordData), gated `if (replicatedRecordEmitter && relationships)`; (2) `src/core/ws2SendWiring.ts` moves `relationships` from `WS2_SEND_PENDING_STORES` to `WS2_SEND_WIRED_STORES`; (3) a new e2e round-trip test `tests/e2e/ws2-relationships-cross-instance.test.ts`. No decision-point surface is added — the only "decision" is the pre-existing dark gate (`isStoreEmissionEnabled`) inside the generic emitter.

## Decision-point inventory

- `ReplicatedRecordEmitter.emit` dark gate (`stateSync.relationships.enabled`) — **pass-through** — already exists; this change merely makes `relationships` a registered emit target. Default `false` ⇒ strict no-op.
- `RelationshipManager.save`/`delete` emit funnel — **pass-through** — the manager already fires emitPut@904 / emitDelete@695,734; this change attaches a real emitter where there was `undefined` (no-op).
- `ws2SendWiring` ratchet classification — **modify** — `relationships` reclassified PENDING→WIRED (it is now genuinely send-wired).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The emitter never rejects a manager write; a null recordKey / null projection / over-cap record is a counted no-op inside `emit()` and the local write always succeeds.

## 2. Under-block

Not applicable (no block surface). The one "miss" worth naming: a relationship with NO channels has no cross-machine identity surface (`deriveRelationshipRecordKey` → null) and is intentionally not replicated — by design (REQ-D17), not a gap; such a record is local-only and surfaces nowhere on the peer.

## 3. Level-of-abstraction fit

Correct layer. The generic `ReplicatedRecordEmitter` + `ReplicatedStoreReader` substrate (built in #1168) is the right home; this change is a table-row registration onto it, exactly as the spec's `tracked-next-work` (WS2-SEND-2) prescribes. No new parallel mechanism; the disclosure-minimized projection lives in `RelationshipsReplicatedStore` where the receive-side schema already lives.

## 4. Signal vs authority compliance

Compliant. This adds NO blocking authority. The emitter is an additive, best-effort signal-producer: a failure (builder throw, journal fault) is swallowed + counted, never propagated, so the manager's local write can never fail because replication did (`@silent-fallback-ok` documented at both call sites). The union read is advisory (HIGH tier = append-both-and-flag; it injects both variants as hints, never blocks). Per `docs/signal-vs-authority.md`, this is a detector/replicator with no gate authority.

## 5. Interactions

- Shares `server.ts`'s single `replicatedRecordEmitter` + the existing `relationshipsUnionReader` (already constructed @3927, previously unconsumed for send). No double-fire: emitPut rides the single `save()` persistence funnel; emitDelete rides the single `delete()` path.
- Does not shadow or race learnings — distinct store key (`relationships` vs `learnings`), distinct journal kind (`relationship-record`).
- Touches the same `server.ts` + `ws2SendWiring.ts` as the other five WS2-SEND stores → those PRs must SERIALIZE (stated in the run plan); no parallel WS2-SEND PRs.

## 6. External surfaces

Dark by default (`multiMachine.stateSync.relationships.enabled` defaults false). With the flag off: byte-identical single-machine behavior — nothing crosses the wire, no external surface changes. With the flag on (multi-machine, opt-in): the disclosure-minimized, channel-keyed projection of a relationship crosses to paired machines — NEVER the local UUID `id`, NEVER the raw on-disk blob (REQ-M4). A received record is rendered as quoted `<replicated-untrusted-data>`, never authoritative for inbound-principal identity resolution (which stays local-only, REQ-M14). At-rest honesty already documented in the WS2.3 spec + CLAUDE.md relationships section.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated** — this IS a cross-machine replication path. Replication path: `RelationshipManager.save/delete` → `ReplicatedRecordEmitter.emit` → `CoherenceJournal.emitReplicatedRecord` (own-stream) → peer serve/apply → `ReplicatedPeerStreamReader.loadOriginRecords` → `relationshipsUnionReader` (no-clobber union, conflict-flagged). Identity across machines = the CHANNEL SET (not the per-machine UUID), so the same person on two machines collapses to one recordKey. Deletes propagate as channel-keyed tombstones so an erased person stays erased even on an offline-then-rejoining peer (REQ-D4). No user-facing notice surface (no one-voice gating needed). No topic-transfer state to strand. No generated URLs.

## 8. Rollback cost

Trivial. The feature is dark by default; if wrong in production it affects only agents that explicitly enabled `stateSync.relationships`. Back-out = revert the three-file commit (or set the flag false — instant, no restart-coupled data migration). The receive-side + envelope schema already shipped and are unaffected. No data migration, no agent-state repair.

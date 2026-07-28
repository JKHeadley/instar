# Side-Effects Review — WS2-SEND-3: preferences send-side replication (emit seam authored)

**Version / slug:** `ws2-send-3-preferences`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no block/allow/lifecycle authority — additive, dark-gated data-replication wiring; see §4)

## Summary of the change

Completes WS2 send-side emission — the LAST of the 7 replicated stores. `preferences` had NO emit seam (it rode the deprecated `preferences-sync` mesh verb), so this AUTHORS one:

- `src/core/PreferencesManager.ts`: a new `PreferenceReplicationEmitter` interface + private `replication` field + `setReplicationEmitter()` (mirroring RelationshipManager), and a best-effort `this.replication?.emitPut(result)` fired at the end of `recordPreference` (after the durable write). PUT-ONLY: `recordPreference` is the sole writer and upserts on `dedupeKey`; there is no delete path.
- The sole `recordPreference` writer is the correction-loop's per-request PreferencesManager in `routes.ts` (16739). The journal emitter is plumbed to it through the EXISTING RouteContext replication-field channel: `replicatedRecordEmitter` added to `RouteContext` (routes.ts) + `AgentServerOptions` + the AgentServer→ctx forward + the server.ts AgentServer construction; routes.ts attaches it to `prefs` right after construction.
- `src/core/ws2SendWiring.ts`: `preferences` PENDING→WIRED; `WS2_SEND_PENDING_STORES` is now EMPTY (all 7 stores wired).

The union reader + projection already shipped (WS2.1). New e2e round-trip.

## Decision-point inventory

- `ReplicatedRecordEmitter.emit` dark gate (`stateSync.preferences.enabled`) — **pass-through** — pre-existing; `preferences` becomes a registered emit target. Default false ⇒ no-op.
- `PreferencesManager.recordPreference` emit funnel — **NEW (additive)** — the authored seam fires emitPut after the durable write, best-effort (try/catch). When no emitter is attached (default) it is a strict no-op — byte-identical single-machine behavior.
- `RouteContext.replicatedRecordEmitter` plumb — **NEW field (additive)** — null while dark; mirrors the existing preferenceReplicaStore plumbing.
- `ws2SendWiring` ratchet — **modify** — `preferences` reclassified PENDING→WIRED; PENDING now empty.

---

## 1. Over-block
No block/allow surface. The emitter never rejects a preference write; null projection / over-cap is a counted no-op and the local write always succeeds.

## 2. Under-block
Not applicable (no block surface). PUT-ONLY is correct + complete: `recordPreference` only upserts (keyed on dedupeKey, bumping a counter + refreshing the learning), so a put carries the latest state and there is no delete event to wire — there is no tombstone by construction. The authored seam fires on the SOLE write path (the correction loop), so capture is complete (unlike userRegistry, preferences has exactly one writer).

## 3. Level-of-abstraction fit
Correct layer. The seam lives on the manager (mirroring every other store's seam); the attach happens at the single write site via the existing RouteContext replication-field channel. No new abstraction.

## 4. Signal vs authority compliance
Compliant. No blocking authority. The authored seam is additive/best-effort: a builder/journal fault is swallowed + counted, never propagated, so a preference write can never fail because replication did (the durable write already completed before the emit). The union read is advisory HIGH-tier (a replicated preference is a HINT, never authoritative). Per `docs/signal-vs-authority.md`.

## 5. Interactions
- Uses the single `replicatedRecordEmitter`, plumbed to routes via the new RouteContext field. Distinct store key/kind from the other WS2 stores. No double-fire (recordPreference is the single funnel; an upsert re-emits the latest, which is the intended status-refresh behavior).
- Touches `server.ts` + `ws2SendWiring.ts` (shared WS2-SEND files) + PreferencesManager.ts + routes.ts + AgentServer.ts → serialized on top of merged userRegistry; no parallel WS2-SEND PRs.

## 6. External surfaces
Dark by default (`multiMachine.stateSync.preferences`). Off ⇒ byte-identical single-machine behavior (the authored seam is a no-op without an attached emitter). On (multi-machine, opt-in): crosses the dedupeKey-keyed projection (learning text — credential-scrubbed, confidence, dedupeCount, provenance, recordedAt); the `violationPattern` is NEVER included (local-only). A received record is quoted `<replicated-untrusted-data>`, advisory only.

## 7. Multi-machine posture (Cross-Machine Coherence)
**Replicated (put-only).** Path: `recordPreference → (authored seam) emitPut → ReplicatedRecordEmitter.emit → CoherenceJournal.emitReplicatedRecord → peer serve/apply → ReplicatedPeerStreamReader → preferencesUnionReader`. Identity = dedupeKey (the same learned preference on two machines collapses to one record). An upsert re-emits the latest (HLC-ordered). No delete path. Verified end-to-end by the new e2e (put round-trip + upsert re-replicates refreshed learning + bumped confidence).

## 8. Rollback cost
Trivial. Dark by default. Back-out = revert the change or set the flag false (instant, no migration). The authored seam is inert without an attached emitter, so reverting only the server.ts/routes plumbing (leaving the manager seam) is also safe. Receive-side + envelope schema already shipped, unaffected.

# Side-Effects Review — WS2-SEND-2: evolutionActions send-side replication (+ PoW test flake fix)

**Version / slug:** `ws2-send-2-evolution-actions`
**Date:** `2026-06-15`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required` (no block/allow/lifecycle authority — additive, dark-gated data-replication wiring; see §4)

## Summary of the change

Extends WS2 send-side emission to the `evolutionActions` store (the next WS2-SEND-2 table-row store after `relationships` + `knowledge`). Mirrors the proven pattern: `src/commands/server.ts` adds `buildEvolutionActionRecordData` + `buildEvolutionActionTombstoneData` to the existing `EvolutionActionsReplicatedStore` destructure and attaches the generic `ReplicatedRecordEmitter` to `evolution.setEvolutionActionReplicationEmitter` (replacing the prior `void` placeholder), gated `if (replicatedRecordEmitter)`; `src/core/ws2SendWiring.ts` moves `evolutionActions` PENDING→WIRED; a new e2e round-trip `tests/e2e/ws2-evolution-actions-cross-instance.test.ts`. The evolution-actions union reader already existed (@8673). `evolution` is the canonical EvolutionManager handed to the AgentServer, so the action-queue routes' real writes flow through the attached hooks (verified: the emit funnel lives in `EvolutionManager.saveActions`, which both addAction and updateAction route through).

**Re-scoping note (honest):** the prior plan batched evolutionActions + userRegistry + topicOperator as one PR on the assumption all three were "just replace the void line." Grounding disproved that for the other two: `userRegistry`'s writes go through ad-hoc UserManager instances + the CLI, and `topicOperator`'s authoritative writer is the AgentServer's own `TopicOperatorStore` — both need the emitter plumbed INTO the AgentServer, not the server.ts mirror. Only `evolutionActions` is a clean canonical-instance attachment. So this PR ships `evolutionActions` alone (high-confidence, the emit genuinely fires on real writes); userRegistry + topicOperator follow in WS2-SEND-2b with the AgentServer plumbing. This is correctness-driven granularity, not deferral — both remain in `WS2_SEND_PENDING_STORES` with their real blocker stated.

**Bundled fix (suite integrity):** `tests/integration/unified-trust-system.test.ts` "rejects PoW for wrong IP" was probabilistically flaky — it solved a PoW at difficulty 8 for one IP and asserted the same nonce is invalid for another IP, but a random hash clears 8 leading-zero bits with probability 1/256, so ~0.4% of CI runs false-accepted and the assertion flipped (observed blocking this very PR train). Raised that one test's difficulty to 16 (false-accept ≈ 1.5e-5, negligible; solve stays <60ms). Zero-Failure-Standard fix encountered while merging — included here rather than left to flake the train again.

## Decision-point inventory

- `ReplicatedRecordEmitter.emit` dark gate (`stateSync.evolutionActions.enabled`) — **pass-through** — pre-existing; `evolutionActions` is now a registered emit target. Default false ⇒ no-op.
- `EvolutionManager.saveActions` emit funnel — **pass-through** — the manager already fires emitPut per survivor + emitDelete per pruned action (@1212); this attaches a real emitter where there was a no-op.
- `ws2SendWiring` ratchet — **modify** — `evolutionActions` reclassified PENDING→WIRED.
- PoW wrong-IP test difficulty 8→16 — **modify (test only)** — no production behavior; removes a probabilistic CI flake.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The emitter never rejects an action write; a null recordKey / null projection / over-cap action is a counted no-op and the local action-queue write always succeeds.

## 2. Under-block

Not applicable (no block surface). An action with an empty identity anchor (no title/createdAt ⇒ `deriveEvolutionActionRecordKey` null) has no cross-machine fingerprint and is intentionally not replicated — local-only. A terminal completed/cancelled action that is RETAINED is NOT tombstoned; only a real queue-removal (prune-over-maxActions) emits a delete — the resurrection guard is preserved.

## 3. Level-of-abstraction fit

Correct layer. Table-row registration onto the generic #1168 substrate, exactly as the spec's WS2-SEND-2 prescribes. The disclosure-minimized projection lives in `EvolutionActionsReplicatedStore` alongside the receive-side schema.

## 4. Signal vs authority compliance

Compliant. No blocking authority. The emitter is additive/best-effort: a builder/journal failure is swallowed + counted (the `saveActions` try/catch guards each emit), never propagated, so an action write can never fail because replication did. The union read is advisory (HIGH tier append-both-and-flag — two divergent states, e.g. completed vs in_progress, inject BOTH as hints rather than silently clobbering). Per `docs/signal-vs-authority.md`, a replicator with no gate authority.

## 5. Interactions

- Shares `server.ts`'s single `replicatedRecordEmitter` + the existing `evolutionActionsUnionReader`. No double-fire: emitPut/emitDelete ride the single `saveActions` path. Distinct store key/kind from learnings + relationships + knowledge.
- `evolution` (EvolutionManager) is the SAME instance that owns learnings replication (already WIRED) — the two seams are independent (`setLearningReplicationEmitter` vs `setEvolutionActionReplicationEmitter`), distinct store keys, no cross-talk.
- Touches the same `server.ts` + `ws2SendWiring.ts` as the other WS2-SEND stores → serialized (built on top of merged #1170 knowledge; no parallel WS2-SEND PRs).

## 6. External surfaces

Dark by default (`multiMachine.stateSync.evolutionActions.enabled`). Off ⇒ byte-identical single-machine behavior. On (multi-machine, opt-in): only the enumerated action projection crosses (title, description, priority, status, createdAt, tags, optional commitTo/resolution/dueBy/completedAt/source) — NEVER the local `ACT-NNN` id (fork #1). The load-bearing field is `status`: a peer SEES an action was already completed/in_progress elsewhere so it does not redo it. A received record is quoted `<replicated-untrusted-data>`, advisory work-item only.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Path: `EvolutionManager.addAction/updateAction → saveActions` → `ReplicatedRecordEmitter.emit` → `CoherenceJournal.emitReplicatedRecord` → peer serve/apply → `ReplicatedPeerStreamReader.loadOriginRecords` → `evolutionActionsUnionReader` (no-clobber union, conflict-flagged). Identity = content fingerprint (title + commitTo + createdAt). A STATUS CHANGE re-emits (saveActions re-emits every survivor), so a peer sees the latest status. An actual queue-removal propagates a fingerprint-keyed tombstone (a later `delete` hlc wins — no resurrection). No user-facing notice surface; no topic-transfer state; no generated URLs. Verified end-to-end by the new e2e (put round-trip + status-change re-replication on real journal serve/apply).

## 8. Rollback cost

Trivial. Dark by default; affects only agents that enable `stateSync.evolutionActions`. Back-out = revert the three-file change or set the flag false (instant, no migration). Receive-side + envelope schema already shipped, unaffected. The test-difficulty bump is pure test hygiene, independently revertible.

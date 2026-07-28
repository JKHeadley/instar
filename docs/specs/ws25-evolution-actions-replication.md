---
title: "WS2.5 — Evolution Action-Queue Cross-Machine Replication: Spec"
slug: "ws25-evolution-actions-replication"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "ws25-evolution-actions-replication.eli16.md"
status: "converged"
review-convergence: "2026-06-13T12:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-06-13T12:00:00.000Z"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-12/13: full session pre-approval for this initiative's decisions (exercised by Echo in the pre-approved autonomous run; operator may revoke). Build prompt: .instar/plans/ws25-evolution-build-prompt.md"
parent-spec: "docs/specs/multi-machine-replicated-store-foundation.md (WS2.5); docs/specs/ws24-knowledge-replication.md (the memory-family sibling this mirrors); docs/specs/ws22-learnings-replication.md (the EvolutionManager emit-seam pattern this reuses)"
lessons-engaged:
  - "L15 Authorization: reach ≠ authority — the consumer read path injects a peer's action as ADVISORY work-item (quoted untrusted data), never as authority; a replicated record never clobbers a divergent local one."
  - "P4 Testing Integrity: three tiers + named invariant tests (recordKey-identity collapse with status excluded from the key, STATUS-CHANGE-RE-EMITS, TERMINAL-IS-NOT-A-DELETE, prune-emits-tombstone/no-resurrection, disclosure-min projection / ACT-id-leak, type-clamp, union-reader-cannot-be-bypassed, append-both advisory)."
  - "P17 Bounded Notification Surface: HIGH-impact conflicts coalesce through the existing ConflictStore (one deduped conflictId per recordKey), never per record."
  - "Phase C: design holds for N machines — no LAN assumption; the content-fingerprint recordKey collapses the same action across an arbitrary pool; bounded per-store budget independent of pool size."
dependency-gate:
  blocks: "WS2.5 reuses the MERGED WS2 generic replicated-store layer (HLC, snapshot-then-tail, envelope, union-reader, ConflictStore, RollbackUnmerge) and the WS2.4 knowledge / WS2.2 learnings machinery."
  status: "SATISFIED — verified on 2026-06-13: knowledge-record present in CoherenceJournal.ts (WS2.4 #1121 merged to JKHeadley/main @ ecb0d9319); learning-record present (WS2.2 #1120); the foundation primitives are real exported symbols."
  enforcement: "The dual-registry coupling test asserts evolution-action-record in BOTH JOURNAL_KINDS and ReplicatedKindRegistry before it can serve/pull."
cross-model-review: "not-run (pre-approved autonomous build mirroring the merged WS2.4 template exactly; the 5 adversarial lenses are exercised in tests/unit/EvolutionActionsReplicatedStore.test.ts)"
tracked-followups: "WS2.6 (playbook) is an ARCHITECTURAL MISMATCH (Python-script-written manifest, no TS emit-seam) — deferred <!-- tracked: CMT-1416 -->; see the tracker's WS2.6 decision note."
---

# WS2.5 — Evolution Action-Queue Cross-Machine Replication

The FIFTH concrete consumer of the HLC replicated-store foundation and the FOURTH
memory-family kind (after WS2.4 knowledge, WS2.2 learnings, and WS2.3 relationships). It layers
an `evolution-action-record` replicated kind onto the generic substrate so a self-improvement
ACTION the agent raised on machine A is known on machine B — ONE action queue, not
one-per-machine. Pure mechanism, dark by default behind `multiMachine.stateSync.evolutionActions`;
a single-machine install is a strict no-op.

This spec is the build prompt at `.instar/plans/ws25-evolution-build-prompt.md`, captured here
as a converged + (pre-)approved spec file so the instar-dev precommit gate can verify the change
shipped through review. The build mirrors the merged WS2.4 PR (#1121) exactly — WS2.4/WS2.2
established ALL the machinery; WS2.5 REUSES it, it does not reinvent it.

## Record type (grounded)

`ActionItem` (`src/core/types.ts:1309`) — `{ id (ACT-NNN), title, description,
priority:'critical'|'high'|'medium'|'low', status:'pending'|'in_progress'|'completed'|'cancelled',
commitTo?, createdAt (ISO), dueBy?, completedAt?, resolution?, source?:{platform?,contentId?,context?},
tags? }`. Stored by `EvolutionManager` as `ActionState { actions: ActionItem[], stats }` at
`state/action-queue.json` via `loadActions()`/`saveActions()`. Mutators: `addAction()` (pushes a
pending action) and `updateAction(id, {status, resolution})` (mutates status/completedAt). The
`ACT-NNN` id is assigned per-machine sequentially (`nextActionId`) — the cross-machine-UNSTABLE id.
`saveActions()` prunes completed/cancelled actions over `maxActions` (default 300) — the only path
that actually REMOVES an action from the queue.

## DECIDED forks (Echo, 2026-06-13 — blanket pre-approval applies)

1. **recordKey = a content fingerprint over the STABLE action identity, NEVER the local `ACT-NNN`
   id.** The id is local-sequential — exactly the relationship-UUID / LRN-id trap solved with a
   stable identity surface. The same committed action on two machines must collapse to ONE record,
   so `recordKey = sha256(normalize(title) + '\x1f' + normalize(commitTo || '') + '\x1f' + createdAt)`,
   hex-truncated to 32 chars. `createdAt` is the strong disambiguator; `commitTo` distinguishes the
   same-titled action made to two people. **`status`/`priority`/`completedAt` are DELIBERATELY
   excluded from the key** — they are the MUTABLE fields (fork #2); keying on them would fork a NEW
   record on every status change instead of updating the one record. Collision-resistant + deterministic.
2. **`status`/`completedAt`/`priority` are MUTABLE → last-writer-witness wins; a concurrent
   divergence rides the SAME append-both-and-flag path (NOT a CRDT special-case).** The canonical
   case: machine A marks an action `completed` while B still has it `in_progress` — the
   witness-ordered later write wins; a genuine concurrent divergence surfaces BOTH states via the
   ConflictStore. A status change MUST RE-EMIT (the whole point — a peer must SEE an action was
   already completed elsewhere so it does not redo the work; both `addAction` and `updateAction`
   route through `saveActions`, which re-emits every surviving action). A `completed`/`cancelled`
   action is a TERMINAL state — its record is RETAINED (history), NOT tombstoned, UNLESS the action
   is actually REMOVED from the queue (the prune-over-maxActions path), which emits an `op:delete`
   tombstone (the resurrection guard).
3. **Impact tier = HIGH at the REPLICATION layer, ADVISORY at the READ layer.** Concurrent divergent
   edits to the SAME recordKey from different origins (completed vs in_progress) → ConflictStore
   APPEND-BOTH-AND-FLAG (idempotent stable conflictId). The consumer read path injects BOTH variants
   as advisory hints on an OPEN conflict rather than BLOCKING — an action is a work item to surface,
   not authority. Operator resolution via `POST /state/resolve-conflict` is OPTIONAL cleanup.

## Scope (mirrors WS2.4 #1121)

1. Register `evolution-action-record` in the DUAL registry — `JournalKind` union + `JOURNAL_KINDS`
   const + `DEFAULT_RETENTION` (rotateKeep > 0) + `ReplicatedKindRegistry.register()` with the strict
   typed schema (discriminated union on `op`; two-sided type-clamp: `createdAt`/`dueBy`/`completedAt`
   ISO-8601-or-absent, `priority`/`status` enum, `tags[]` string[]; a path-shaped `source` sub-field
   jailed). The local `id` is DELIBERATELY ABSENT from the store schema.
2. New consumer `src/core/EvolutionActionsReplicatedStore.ts` — `buildEvolutionActionRecordData()`
   disclosure-minimized projection (local ACT id stripped from every emit; 64KB per-entry cap — a
   description can be long; a named `EvolutionActionRecordTooLargeError` over-cap rejection, never
   silent-truncate); `op:'delete'` tombstone with the delete-resurrection guard + offline-peer erasure.
3. Emit on action write — `EvolutionManager.saveActions()` (the single funnel both `addAction` and
   `updateAction` route through) re-emits a `put` per surviving action (so a status change re-emits)
   and emits an `op:delete` tombstone per action REMOVED over `maxActions`, gated behind
   `multiMachine.stateSync.evolutionActions.enabled` (default false ⇒ strict no-op). CRITICAL: the
   prune path emits the tombstone, else a peer re-replicates a locally-removed action forever
   (resurrection). The emit seam is injected (absent ⇒ no-op) so the dark default is byte-identical.
4. Read through `UnionReader` — single-origin → return; sequential-after via observed witness →
   later wins; concurrent → ConflictStore append-both-and-flag. The union-reader cannot be bypassed
   (§12 wiring test).
5. Snapshot-then-tail join, ReplicationBudget per-kind bounds+coalescing, RollbackUnmerge namespace
   drop.
6. Config (`multiMachine.stateSync.evolutionActions` via ConfigDefaults add-missing migration) +
   advert self-report + CLAUDE.md template awareness + PostUpdateMigrator.

## Adversarial review lenses (folded before commit)

1. **recordKey-identity** — the title+commitTo+createdAt fingerprint collapses the same action
   across machines (verified: same action + different local ACT id → same key; trivial
   whitespace/case drift absorbed) AND stays collision-resistant across genuinely-different actions
   (verified: createdAt + commitTo disambiguate; a `\x1f` unit-separator prevents field-straddle
   collisions). status/priority are NOT in the key, so a status change keeps the SAME recordKey
   (updates, not forks) — explicitly tested.
2. **status-merge correctness** — `updateAction` re-emits (verified: a status change re-fires a put
   carrying the new status); a concurrent completed-vs-in_progress rides append-both-and-flag, no
   CRDT special-case; a TERMINAL completed/cancelled action is RETAINED (a put), not tombstoned —
   only an actual queue-removal tombstones (both explicitly tested).
3. **disclosure-min** — NO local `id` ever appears in an outbound batch (verified by an allowlist
   assertion + a JSON-serialization guard asserting the ACT id is absent); description/free text
   under the 64KB cap.
4. **type-clamp completeness** — `createdAt`/`dueBy`/`completedAt` ISO-8601-or-absent, `priority`/
   `status` enum, `tags[]` string[] clamped on BOTH emit and apply; a path-shaped `source.contentId`
   jailed; free-text `description`/`title` length-clamped + sanitized on render.
5. **flag-coherence leak** — emission to a non-advertising peer is impossible (the foundation's
   `shouldEmitToPeer` gate; `selfStateSyncReceive` advertises `evolutionActions:true` IFF the store
   is enabled).

## Open questions

*(none)*

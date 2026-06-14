---
title: "WS2.2 — Learnings Cross-Machine Replication: Spec"
slug: "ws22-learnings-replication"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "ws22-learnings-replication.eli16.md"
status: "converged"
review-convergence: "2026-06-13T08:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-06-13T08:00:00.000Z"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-12/13: full session pre-approval for this initiative's decisions (exercised by Echo in the pre-approved autonomous run; operator may revoke). Build prompt: .instar/plans/ws22-learnings-build-prompt.md"
parent-spec: "docs/specs/multi-machine-replicated-store-foundation.md (WS2.2); docs/specs/ws23-relationships-userregistry-security.md (the PII machinery this REUSES)"
lessons-engaged:
  - "L15 Authorization: reach ≠ authority — the consumer read path injects a peer's learning as ADVISORY guidance (quoted untrusted data), never as authority; a replicated record never clobbers a divergent local one."
  - "P4 Testing Integrity: three tiers + named invariant tests (recordKey-identity collapse, prune-emits-tombstone/no-resurrection, disclosure-min, type-clamp, union-reader-cannot-be-bypassed, append-both advisory)."
  - "P17 Bounded Notification Surface: HIGH-impact conflicts coalesce through the existing ConflictStore (one deduped conflictId per recordKey), never per record."
  - "Phase C: design holds for N machines — no LAN assumption; the content-fingerprint recordKey collapses the same lesson across an arbitrary pool; bounded per-store budget independent of pool size."
dependency-gate:
  blocks: "WS2.2 reuses the MERGED WS2 generic replicated-store layer (HLC, snapshot-then-tail, envelope, union-reader, ConflictStore, RollbackUnmerge) and the WS2.3 PII machinery."
  status: "SATISFIED — verified on 2026-06-13: relationship-record present in CoherenceJournal.ts (WS2.3 #1119 merged to JKHeadley/main @ 8c7c4240c); the foundation primitives are real exported symbols."
  enforcement: "The dual-registry coupling test asserts learning-record in BOTH JOURNAL_KINDS and ReplicatedKindRegistry before it can serve/pull."
cross-model-review: "not-run (pre-approved autonomous build mirroring the merged WS2.3 template exactly; the 5 adversarial lenses are exercised in tests/unit/LearningsReplicatedStore.test.ts)"
tracked-followups: "<!-- tracked: CMT-1416 --> WS2.4 (KB) / WS2.5 (evolution) / WS2.6 (playbook) reduce to schema+projection+flag on this same machinery."
---

# WS2.2 — Learnings Cross-Machine Replication

The THIRD concrete consumer of the HLC replicated-store foundation and the SECOND
memory-family kind (after WS2.3 relationships). It layers a `learning-record` replicated
kind onto the generic substrate so a lesson the agent learned on machine A is known on
machine B — ONE learning registry, not one-per-machine. Pure mechanism, dark by default
behind `multiMachine.stateSync.learnings`; a single-machine install is a strict no-op.

This spec is the build prompt at `.instar/plans/ws22-learnings-build-prompt.md`, captured
here as a converged + (pre-)approved spec file so the instar-dev precommit gate can verify
the change shipped through review. The build mirrors the merged WS2.3 PR (#1119) exactly —
WS2.3 established ALL the PII machinery; WS2.2 REUSES it, it does not reinvent it.

## Record type (grounded)

`LearningEntry` (`src/core/types.ts:1224`) — `{ id (LRN-NNN), title, category, description,
source: LearningSource, tags[], applied, appliedTo?, evolutionRelevance? }`. `LearningSource`
= `{ agent?, platform?, contentId?, discoveredAt (ISO), session? }`. Persisted by
`EvolutionManager` at `state/evolution/learning-registry.json`; `maxLearnings` default 500,
the prune path at `EvolutionManager.saveLearnings`.

## DECIDED forks (Echo, 2026-06-13 — blanket pre-approval applies)

1. **recordKey = a content fingerprint, NEVER the local `LRN-NNN` id.** The LRN id is local
   + sequential (assigned per-machine), so it is the cross-machine-UNSTABLE id — exactly the
   relationship-UUID trap WS2.3 solved with the channel-set key. The SAME lesson learned on
   two machines must collapse to ONE record, so `recordKey =
   sha256(normalize(title) + '\x1f' + normalize(category) + '\x1f' + (source.contentId ||
   source.discoveredAt))`, hex-truncated to 32 chars. Collision-resistant + deterministic.
2. **Impact tier = HIGH at the REPLICATION layer, ADVISORY at the READ layer.** Concurrent
   divergent edits to the SAME recordKey from different origins → ConflictStore
   APPEND-BOTH-AND-FLAG (idempotent stable conflictId). The consumer read path injects BOTH
   variants as advisory hints on an OPEN conflict rather than BLOCKING — a learning is
   guidance, not authority. Operator resolution via `POST /state/resolve-conflict` is
   OPTIONAL cleanup that collapses the flag, never a gate on the hint.
3. **`applied`/`appliedTo` are LOCAL-merge fields, replicated but last-writer-witness wins.**
   A concurrent applied-vs-unapplied divergence on the same recordKey rides the SAME
   append-both-and-flag path (NOT a special CRDT merge) — the single conflict path.

## Scope (mirrors WS2.3 #1119)

1. Register `learning-record` in the DUAL registry — `JournalKind` union + `JOURNAL_KINDS`
   const + `ReplicatedKindRegistry.register()` with the strict typed schema (discriminated
   union on `op`; two-sided type-clamp: `source.discoveredAt` ISO-8601, `applied` boolean,
   `tags[]` string[]). The local `id` is DELIBERATELY ABSENT from the store schema.
2. New consumer `src/core/LearningsReplicatedStore.ts` — `buildLearningRecordData()`
   disclosure-minimized projection (local LRN id stripped from every emit; 64KB per-entry
   cap — a learning description can be long); `op:'delete'` tombstone with the
   delete-resurrection guard + offline-peer erasure.
3. Emit on learning write — `EvolutionManager.saveLearnings()` emits a `ReplicatedEnvelope`
   per changed recordKey, gated behind `multiMachine.stateSync.learnings.enabled` (default
   false ⇒ strict no-op). CRITICAL: the prune-over-500 path emits `op:delete` tombstones for
   pruned learnings, else a peer re-replicates them (resurrection).
4. Read through `UnionReader` — single-origin → return; sequential-after via observed witness
   → later wins; concurrent → ConflictStore append-both-and-flag. The union-reader cannot be
   bypassed (§12 wiring test).
5. Snapshot-then-tail join, ReplicationBudget per-kind bounds+coalescing, RollbackUnmerge
   namespace drop.
6. Config (`multiMachine.stateSync.learnings` via ConfigDefaults add-missing migration) +
   advert self-report + CLAUDE.md template awareness + PostUpdateMigrator.

## Adversarial review lenses (folded before commit)

1. **recordKey-identity** — the content fingerprint collapses the same lesson across machines
   (verified: same lesson, different LRN id → same key; trivial whitespace/case drift
   absorbed) AND stays collision-resistant across genuinely-different lessons (verified: a
   `\x1f` unit-separator delimiter prevents field-straddle collisions; contentId
   disambiguates).
2. **prune / tombstone resurrection** — a locally-pruned learning over max-500 emits
   `op:delete` (verified in `evolution-manager-learning-replication.test.ts`); a later delete
   hlc wins over an earlier put in the merge.
3. **disclosure minimization** — no field outside the projection enumeration crosses; the
   local LRN id is stripped; a long description is bounded under the 64KB cap (a named
   `LearningRecordTooLargeError` over-cap rejection, never silent-truncate).
4. **type-clamp completeness** — `source.discoveredAt` ISO-8601, `applied` strict boolean,
   `tags[]` string[] clamped on BOTH emit and apply; free-text length-clamped + sanitized on
   render.
5. **flag-coherence PII-leak** — emission to a non-advertising peer is impossible (the
   foundation's `shouldEmitToPeer` gate; `selfStateSyncReceive` advertises `learnings:true`
   IFF the store is enabled).

## Open questions

*(none)*

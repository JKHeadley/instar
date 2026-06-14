---
title: "WS2.4 — Knowledge-Base Cross-Machine Replication: Spec"
slug: "ws24-knowledge-replication"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "ws24-knowledge-replication.eli16.md"
status: "converged"
review-convergence: "2026-06-13T09:00:00.000Z"
review-iterations: 1
review-completed-at: "2026-06-13T09:00:00.000Z"
approved: true
approved-by: "operator pre-approval — Justin, topic 13481, 2026-06-12/13: full session pre-approval for this initiative's decisions (exercised by Echo in the pre-approved autonomous run; operator may revoke). Build prompt: .instar/plans/ws24-knowledge-build-prompt.md"
parent-spec: "docs/specs/multi-machine-replicated-store-foundation.md (WS2.4); docs/specs/ws23-relationships-userregistry-security.md (the PII machinery this REUSES); docs/specs/ws22-learnings-replication.md (the memory-family sibling this mirrors)"
lessons-engaged:
  - "L15 Authorization: reach ≠ authority — the consumer read path injects a peer's knowledge source as ADVISORY reference (quoted untrusted data), never as authority; a replicated record never clobbers a divergent local one."
  - "P4 Testing Integrity: three tiers + named invariant tests (recordKey-identity collapse, remove-emits-tombstone/no-resurrection, metadata-only projection / filePath-leak, type-clamp, union-reader-cannot-be-bypassed, append-both advisory)."
  - "P17 Bounded Notification Surface: HIGH-impact conflicts coalesce through the existing ConflictStore (one deduped conflictId per recordKey), never per record."
  - "Phase C: design holds for N machines — no LAN assumption; the content-fingerprint recordKey collapses the same source across an arbitrary pool; bounded per-store budget independent of pool size; the metadata-only scope keeps the per-kind cap pool-independent (the file body never travels)."
dependency-gate:
  blocks: "WS2.4 reuses the MERGED WS2 generic replicated-store layer (HLC, snapshot-then-tail, envelope, union-reader, ConflictStore, RollbackUnmerge) and the WS2.2/WS2.3 PII machinery."
  status: "SATISFIED — verified on 2026-06-13: learning-record present in CoherenceJournal.ts (WS2.2 #1120 merged to JKHeadley/main @ 65f7155d7); relationship-record present (WS2.3 #1119 @ 8c7c4240c); the foundation primitives are real exported symbols."
  enforcement: "The dual-registry coupling test asserts knowledge-record in BOTH JOURNAL_KINDS and ReplicatedKindRegistry before it can serve/pull."
cross-model-review: "not-run (pre-approved autonomous build mirroring the merged WS2.2 template exactly; the 5 adversarial lenses are exercised in tests/unit/KnowledgeReplicatedStore.test.ts)"
tracked-followups: "<!-- tracked: CMT-1416 --> WS2.4 full-content-body sync (beyond catalog metadata) / WS2.5 (evolution) / WS2.6 (playbook) reduce to schema+projection+flag on this same machinery."
---

# WS2.4 — Knowledge-Base Cross-Machine Replication

The FOURTH concrete consumer of the HLC replicated-store foundation and the THIRD
memory-family kind (after WS2.3 relationships and WS2.2 learnings). It layers a
`knowledge-record` replicated kind onto the generic substrate so a knowledge SOURCE the
agent ingested on machine A is known on machine B — ONE knowledge catalog, not
one-per-machine. Pure mechanism, dark by default behind `multiMachine.stateSync.knowledge`;
a single-machine install is a strict no-op.

This spec is the build prompt at `.instar/plans/ws24-knowledge-build-prompt.md`, captured
here as a converged + (pre-)approved spec file so the instar-dev precommit gate can verify
the change shipped through review. The build mirrors the merged WS2.2 PR (#1120) exactly —
WS2.2/WS2.3 established ALL the PII machinery; WS2.4 REUSES it, it does not reinvent it.

## Record type (grounded)

`KnowledgeSource` (`src/knowledge/KnowledgeManager.ts:19`) — `{ id (kb_…), title, url|null,
type:'article'|'transcript'|'doc', ingestedAt (ISO), filePath (relative), tags[], summary,
wordCount }`. Stored by `KnowledgeManager` as `KnowledgeCatalog { sources: KnowledgeSource[] }`
at `state/knowledge/catalog.json`; the ingested CONTENT is a SEPARATE markdown file at
`filePath` (NOT in the catalog). Mutators: `ingest()` (pushes a source + writes the file) and
`remove(sourceId)` (drops the source + deletes the file).

## DECIDED forks (Echo, 2026-06-13 — blanket pre-approval applies)

1. **recordKey = a content fingerprint over the STABLE source identity, NEVER the local
   generated `id`.** The catalog id is local + generated per-machine (`generateId()`), the
   cross-machine-UNSTABLE id — exactly the relationship-UUID / LRN-id trap WS2.3/WS2.2 solved
   with a stable identity surface. The same article ingested on two machines must collapse to
   ONE record, so `recordKey = sha256(normalize(url || title) + '\x1f' + normalize(type))`,
   hex-truncated to 32 chars. `url` is the natural identity when present, else the title.
   Collision-resistant + deterministic.
2. **Replicate the CATALOG ENTRY (metadata) ONLY — NOT the markdown file body.** A
   `KnowledgeSource` points at a separate `filePath` markdown file that can be a huge
   transcript; replicating full bodies would blow the 64KB per-kind cap and balloon the
   journal. The cross-machine-useful payload is the metadata + `summary` (the peer LEARNS the
   source exists, its summary, tags, and url — enough to re-ingest locally if wanted). The
   projection carries `{ title, url, type, ingestedAt, tags[], summary, wordCount }` and
   STRIPS the local `id` + `filePath` (a local artifact path — meaningless and a mild
   info-leak on a peer; never replicated). Full-content sync is a TRACKED follow-up
   (`<!-- tracked: CMT-1416 -->`), the same metadata-only boundary WS2.3 used for its
   user-registry slice.
3. **Impact tier = HIGH at the REPLICATION layer, ADVISORY at the READ layer.** Concurrent
   divergent edits to the SAME recordKey from different origins (e.g. two machines re-summarize
   the same url differently) → ConflictStore APPEND-BOTH-AND-FLAG (idempotent stable
   conflictId). The consumer read path injects BOTH variants as advisory hints on an OPEN
   conflict rather than BLOCKING — a knowledge source is reference, not authority. Operator
   resolution via `POST /state/resolve-conflict` is OPTIONAL cleanup that collapses the flag,
   never a gate on the hint.

## Scope (mirrors WS2.2 #1120)

1. Register `knowledge-record` in the DUAL registry — `JournalKind` union + `JOURNAL_KINDS`
   const + `DEFAULT_RETENTION` (rotateKeep > 0) + `ReplicatedKindRegistry.register()` with
   the strict typed schema (discriminated union on `op`; two-sided type-clamp: `ingestedAt`
   ISO-8601, `type` enum, `wordCount` finite number, `tags[]` string[]; a path-shaped `url`
   jailed). The local `id` + `filePath` are DELIBERATELY ABSENT from the store schema.
2. New consumer `src/core/KnowledgeReplicatedStore.ts` — `buildKnowledgeRecordData()`
   disclosure-minimized, metadata-only projection (local id + filePath stripped from every
   emit; 64KB per-entry cap — a summary can be long; a named `KnowledgeRecordTooLargeError`
   over-cap rejection, never silent-truncate); `op:'delete'` tombstone with the
   delete-resurrection guard + offline-peer erasure.
3. Emit on knowledge write — `KnowledgeManager.ingest()` emits a `put` per ingested source;
   `KnowledgeManager.remove()` emits an `op:delete` tombstone, both gated behind
   `multiMachine.stateSync.knowledge.enabled` (default false ⇒ strict no-op). CRITICAL: the
   remove path emits the tombstone, else a peer re-replicates a locally-removed source forever
   (resurrection). The emit seam is injected (absent ⇒ no-op) so the dark default is
   byte-identical.
4. Read through `UnionReader` — single-origin → return; sequential-after via observed witness
   → later wins; concurrent → ConflictStore append-both-and-flag. The union-reader cannot be
   bypassed (§12 wiring test).
5. Snapshot-then-tail join, ReplicationBudget per-kind bounds+coalescing, RollbackUnmerge
   namespace drop.
6. Config (`multiMachine.stateSync.knowledge` via ConfigDefaults add-missing migration) +
   advert self-report + CLAUDE.md template awareness + PostUpdateMigrator.

## Adversarial review lenses (folded before commit)

1. **recordKey-identity** — the url/title fingerprint collapses the same source across
   machines (verified: same url + different title/local-id → same key; same url collapses even
   when re-titled; trivial whitespace/case drift absorbed) AND stays collision-resistant across
   genuinely-different sources (verified: a `\x1f` unit-separator delimiter prevents
   field-straddle collisions; type disambiguates).
2. **metadata-only projection / filePath leak** — NO `filePath` and NO local `id` ever appear
   in an outbound batch (verified by an allowlist assertion + a filePath-leak guard that
   serializes the projection and asserts the local path value is absent); the summary/title are
   under the 64KB cap.
3. **remove / tombstone resurrection** — a locally-removed source emits `op:delete` (verified
   in `knowledge-manager-replication.test.ts`); a later delete hlc wins over an earlier put in
   the merge; remove-of-nonexistent emits nothing.
4. **type-clamp completeness** — `ingestedAt` ISO-8601, `type` enum, `wordCount` finite number,
   `tags[]` string[] clamped on BOTH emit and apply; a path-shaped `url` jailed; free-text
   `summary`/`title` length-clamped + sanitized on render.
5. **flag-coherence leak** — emission to a non-advertising peer is impossible (the foundation's
   `shouldEmitToPeer` gate; `selfStateSyncReceive` advertises `knowledge:true` IFF the store is
   enabled).

## Open questions

*(none)*

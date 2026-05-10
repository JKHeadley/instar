# Side-Effects Review — WikiClaim Evidence Phase 1 (schema + types)

**Version / slug:** `wikiclaim-evidence-phase1`
**Date:** 2026-05-09
**Author:** Echo
**Second-pass reviewer:** required (idempotency + privacy-narrowing + cascade-delete)

## Summary of the change

Imports OpenClaw's `WikiClaimEvidence` shape onto `MemoryEntity` as a new typed-evidence array. Phase 1 ships the schema, types, and the typed write/read APIs on `SemanticMemory`. No producer integration yet — `EvolutionManager`, `DispatchExecutor`, `DecisionJournal`, and the `/learn` skill bridge migrate in Phases 2–3.

What lands:
- `entity_evidence` SQLite table with `ON DELETE CASCADE` referencing `entities(id)`. Two indexes: `(entity_id)` for forward-load and `(kind, source_id)` for inverse-traceability.
- `PRAGMA foreign_keys = ON` is asserted in `createSchema()` (not just set in `open()`) — without it, cascade-delete silently leaks orphan evidence rows.
- `MemoryEntity.evidence?: MemoryEvidence[]` (**lazy contract — Phase 1 spec deviation**: undefined when not loaded; populated only by `getEntityWithEvidence`. Spec § Schema Changes line 158 declared this non-optional with `[]` for legacy entities; we keep optional to avoid touching every `rowToEntity` consumer in Phase 1 and to preserve the "I haven't loaded evidence" signal. Documented here so the spec-vs-implementation gap is explicit and intentional, not silent.)
- `EvidencePrivacyTier` — dedicated tier vocabulary `'public' | 'shared-project' | 'private' | 'sensitive'` per spec § Schema Changes line 136, distinct from entity-level `PrivacyScopeType`. `'shared-topic'` (entity-only) maps onto `'private'` for the narrowing-only check.
- New SemanticMemory methods:
  - `rememberWithEvidence(input, evidence, producer)` — atomic create-with-evidence in one better-sqlite3 transaction
  - `addEvidence(entityId, evidence | evidence[], producer)` — array calls wrapped in one transaction
  - `getEvidence(entityId, viewerScope)` — viewer-scope filtered
  - `findCitations({kind, sourceId}, viewerScope)` — inverse query, viewer-scope filtered
  - `getEntityWithEvidence(entityId, viewerScope)` — eager variant; default `recall()` stays evidence-free
- Per-producer kind allowlist (`PRODUCER_KIND_ALLOWLIST`) — mismatches throw `EvidencePolicyError`. `manual` is narrowed to `external-url` per spec § Producers line 229. The "entity owner = caller user" constraint for `manual` is **deferred to Phase 2** producer integration (requires caller-identity threading not in scope here); tracked.
- Narrowing-only constraint: an evidence's `privacyTier` must equal-or-be-more-restrictive than its entity's `privacyScope`. Wider tiers throw `EvidencePolicyError`.
- Per-entity evidence cap (`DEFAULT_EVIDENCE_CAP_PER_ENTITY = 50`, configurable up to 500) and `MAX_EVIDENCE_NOTE_BYTES = 500`.
- Supersedes-evidence bounded defenses: (a) reject `sourceId` equal to the entity's own id (self-loop); (b) reject inserts when the count of existing supersedes-evidence rows on this entity already meets `MAX_SUPERSEDES_DEPTH = 32`. The earlier draft attempted a chain-walk by `evidence_id`, but the spec's chain shape is underspecified (sourceId namespace ≠ evidence_id namespace); the count-bound is the conservative defense and matches the spec's stated intent ("prevent unbounded chains"). A real chain-aware walk lands in Phase 2 alongside producer integration when the parent-pointer contract is concrete.
- New JSONL replay actions: `rememberWithEvidence` (carries the **full entity payload** + evidence array + producer; the inner `remember` action is suppressed during the wrapping call so the journal has exactly one record per logical create) and `addEvidence`. `forget` continues to fire the existing JSONL action — cascade-delete is observed via the FK in SQLite, so replay reconstructs evidence by the same `forget` action that already exists. **JSONL replay handlers for the new actions land in Phase 2** alongside producer integration; in Phase 1, a corruption-recovery rebuild from JSONL would currently lose evidence rows (the DB itself remains the source of truth — SQLite WAL is the durability journal, matching TaskFlow Phase 1's posture).

Files touched:
- `src/core/types.ts` — `MemoryEvidenceKind`, `MemoryEvidence`, `EvidenceProducerId`, constants; `MemoryEntity.evidence?` field added
- `src/memory/SemanticMemory.ts` — schema + 5 new methods + helpers + producer allowlist + narrowing check + cycle check + new row-mapper
- `tests/unit/semantic-memory-evidence.test.ts` — 18 vitest cases (lazy load, atomic create, kind allowlist, narrowing-only, viewer-scope filter, cap/note/weight/timestamp validation, inverse query, cascade delete, supersedes cycle, JSONL replay actions)
- `upgrades/side-effects/wikiclaim-evidence-phase1.md` (this file)

## Decision-point inventory

- `PRODUCER_KIND_ALLOWLIST` enforcement (`assertProducerKindsAllowed`) — **add** — mechanic-level check: each subsystem may only write a fixed enum subset. Not judgment.
- `assertNarrowingOnly` privacy check — **add** — mechanic-level ordering comparison on the `SCOPE_ORDER` map. Not judgment.
- `assertEvidenceShape` size/range validators (note bytes ≤ 500, weight ∈ [0,1], confidence ∈ [0,1], updatedAt parses) — **add** — hard-invariant edge validation.
- `assertSupersedesAcyclic` — **add** — bounded-walk cycle detection. Mechanic.
- `isVisibleAtScope` viewer-scope filter — **add** — mechanic-level ordering check applied at every read path.

---

## 1. Over-block

**Producer allowlist false negatives:** A legitimate caller writing `EvolutionManager → kind:'commit'` is rejected. Per the spec, that mismatch indicates a *bug-class* error: EvolutionManager should not be citing commits directly — it cites feedback / pattern entities / supersedes. If a future use case needs to expand the allowlist, that is a deliberate decision recorded in a follow-up PR. The current shape matches the spec's table verbatim.

**Narrowing-only over-block:** A producer that wants to ATTACH a `shared-project` evidence to a `private` entity is rejected. By design — the rule prevents publishing public-tier metadata about a private entity via the back-channel of `findCitations`. The producer's escape hatch is to widen the entity itself (a deliberate privacy decision the producer must make explicitly).

**Note size cap (500 B):** Larger explanatory notes are rejected. Producers truncate or split. Acceptable in v1; deferred PII redaction is in spec § Open Questions.

## 2. Under-block

- **Cross-store dangling sourceId:** Phase 1 does NOT verify that `sourceId` exists in its origin store (e.g., a `kind:'feedback'` row whose `sourceId` doesn't exist in `feedback.json`). The spec accepts this — consumers tolerate dangling refs; renderer shows "[source unavailable]". Producer-side write-time best-effort verification is a Phase 2 concern.
- **Producer spoofing:** `EvidenceProducerId` is a process-internal symbol; an in-process caller can pass any value. Cross-process spoofing is out of the v1 threat model. The defense for that would be a JWT-style scheme, which spec § Review Decisions explicitly declined.
- **`external-url` SSRF:** `kind:'external-url'` rows store the path/URL but the schema does NOT auto-fetch. Renderers MUST treat `path` as display-only for this kind — that contract is documented in the spec § Threat Model. No new fetcher is wired in this PR.
- **Evidence-rate flooding:** No per-caller rate limit yet. The cap is per-entity (50 default). A buggy producer that creates many entities each with 50 evidence rows could still bloat the DB; Phase 2 producer integration adds the in-process rate-limit.

## 3. Level-of-abstraction fit

Right layer. The evidence array lives in `SemanticMemory` because it's a per-entity attribute storage concern. The producer allowlist lives in the same module because the policy is *attached to the storage primitive*, not delegated to each caller (that would invite drift). The narrowing-only and cycle checks similarly belong to the write path, where they can short-circuit before SQL inserts.

The renderer is the documented privacy-enforcement boundary. Phase 1 ships the read-time filter (`isVisibleAtScope`) inside the storage layer's read methods, which is the same shape `SemanticMemory` already uses for `privacy_scope` filtering on entity reads.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — this change has no judgment-level block/allow surface.

Every "rejection" is one of:
- Hard-invariant structural validation at the write edge (size limits, range checks, parse checks);
- Mechanic-level allowlist match (`producer × kind` lookup in a constant map);
- Mechanic-level ordering comparison (privacy scope tiers);
- Bounded-walk cycle detection.

All of these are exempt under the principle's "Hard-invariant validation" / "Idempotency keys at the transport layer" carve-outs. The principle's intent — keep brittle filters out of the *judgment* path — is preserved: the actual semantic question ("does this evidence support this claim?") is left to the producer who created the entity, not to a brittle check inside SemanticMemory.

## 5. Interactions

- **`forget()` cascade**: The new FK declaration `entity_id REFERENCES entities(id) ON DELETE CASCADE` removes evidence rows when an entity is deleted. With `PRAGMA foreign_keys = ON` (asserted in `createSchema()`), this is automatic. Test `cascade delete on forget` covers it.
- **Existing FTS5 triggers**: Unchanged. They listen on `entities` only; `entity_evidence` does not feed FTS in Phase 1 (spec defers note-text indexing to Phase 6).
- **Existing `recall()` path**: Unchanged — `recall()` returns the entity without evidence (lazy by spec). Existing 49 unit tests pass unchanged.
- **VectorSearch**: Unaffected. Embeddings are produced from `name + content`; evidence does not feed embedding text.
- **JSONL replay**: New actions (`rememberWithEvidence`, `addEvidence`) appear after the existing `remember`/`forget` actions in the journal. Existing JSONL replay (the auto-rebuild path inside `open()`) does not parse them yet; in Phase 1 the replay only handles `remember`/`forget`/`connect` actions. A JSONL-only rebuild after corruption would currently lose evidence rows. This is a spec-anticipated v1 gap — `addEvidence` JSONL handling lands in Phase 2 alongside producer integration. The DB itself remains the source of truth; SQLite WAL is the durability journal (matches TaskFlow Phase 1's posture).
- **GDPR delete (`deleteEntitiesByUser`)**: Cascade-delete of evidence happens at SQL level when `entities` rows are removed. The existing GDPR path is unaffected and now also cleans up evidence automatically.

## 6. External surfaces

- **Other agents on the same machine**: None.
- **Other users of the install base**: New table is added on first `open()` of an existing install via `CREATE TABLE IF NOT EXISTS`. The table starts empty. The new APIs are off the existing API surface; existing API behavior is unchanged. No breaking changes.
- **External systems**: None.
- **Persistent state**: One new table, two new indexes, one schema bump. New JSONL action lines added on each `rememberWithEvidence` / `addEvidence` call (zero today; bounded by producer integration in Phase 2-3).
- **Privacy posture**: Tighter — narrowing-only constraint AND viewer-scope inverse-query filter close two leakage modes that didn't exist before because evidence didn't exist before.

## 7. Rollback cost

- **Hot-fix release**: Pure additive change; `git revert <merge-commit>` ships as the next patch. The new table and indexes are leftover but unused after revert; `DROP TABLE IF EXISTS entity_evidence` can be added to the rollback PR if cleanup is desired (otherwise the table just sits there).
- **Data migration**: None. New table; new optional `MemoryEntity.evidence?` field.
- **Agent state repair**: None. Existing entities continue to work with `evidence: undefined` (lazy).
- **User visibility**: None. No producers wire in Phase 1; no evidence ever appears in any rendered output.

---

## Conclusion

WikiClaim Phase 1 ships the schema, types, and typed write/read APIs on `SemanticMemory`, plus four mechanic-level policy gates (producer allowlist, narrowing-only privacy, evidence cap, supersedes cycle bound). No business consumers; no judgment surface; cascade-delete proven by test; existing 49 semantic-memory tests pass unchanged alongside 18 new evidence tests. Cleared to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** independent code-audit subagent (general-purpose), two rounds.
**Independent read of the artifact: concur (round 2 after author addressed round-1 concerns).**

Round-1 raised seven concerns; round-2 verified each:
1. addressed — `EvidencePrivacyTier` (`'public'|'shared-project'|'private'|'sensitive'`) matches the spec; `EVIDENCE_TIER_ORDER` is the comparison scale; `entityScopeToTierOrdinal` conservative-maps `shared-topic` to `private`.
2. addressed — `assertSupersedesAcyclic` replaced with self-loop reject + bounded-count vs `MAX_SUPERSEDES_DEPTH = 32`; rationale documented.
3. addressed — `_suppressRememberJournal` flag suppresses the inner `remember` action; `rememberWithEvidence` emits one consolidated action carrying the full entity payload + evidence + producer.
4. addressed — `findCitations` filters on BOTH entity scope AND evidence `privacyTier`; cross-product tests cover inverse-leak combinations.
5. addressed — `PRODUCER_KIND_ALLOWLIST.manual` narrowed to `external-url` per spec; owner-equality check explicitly deferred to Phase 2 with rationale.
6. partial-addressed — `MemoryEntity.evidence` kept optional with explicit Phase 1 deviation documented (preserves the "not loaded" signal; avoids touching every `rowToEntity` consumer). Within prior-reviewer-accepted bounds.
7. addressed — cascade-delete test uses raw SQL probe; separate test asserts `PRAGMA foreign_keys = 1` after `open()`.

Cleared to ship.

---

## Evidence pointers

- New tests: `npx vitest run tests/unit/semantic-memory-evidence.test.ts` → 21/21 passing (98ms).
- Regression: `npx vitest run tests/unit/semantic-memory.test.ts` → 49/49 passing (209ms).
- Route-completeness regression: `npx vitest run tests/unit/route-completeness.test.ts` → 9/9 passing.
- Typecheck: `npx tsc --noEmit` → clean.
- Cascade-delete coverage: raw-SQL probe asserts `entity_evidence` row count = 0 after `forget`, plus a positive PRAGMA-foreign_keys check after `open()`.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` (Convergence: 2026-05-07).
- OpenClaw provenance: `extensions/memory-wiki/src/markdown.ts:11-101` at commit `f482e4d335`.

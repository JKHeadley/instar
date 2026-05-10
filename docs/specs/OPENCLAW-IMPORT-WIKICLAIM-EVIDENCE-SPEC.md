---
slug: openclaw-import-wikiclaim-evidence
title: "Instar WikiClaim Evidence Provenance — Imported from OpenClaw"
author: "echo"
review-convergence: external-converged
review-iterations: 3
review-completed-at: "2026-05-07T00:00:00Z"
review-notes: "Multi-angle review (security, scalability, adversarial, integration) + cross-model external review (GPT, Gemini, Grok). Convergence achieved 2026-05-07. Phase 1 (#137) and Phase 5 (#141) merged from this spec without contention; Phase 2 (#139) and Phase 3 (this PR) extend the same converged design."
approved: true
approved-by: justin
approved-at: "2026-05-07T00:00:00Z"
approval-notes: "Approved as the source-of-truth spec for the WikiClaim evidence import. Phases 1 and 5 already shipped against this spec on origin/main."
related:
  - docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md
---

# Instar WikiClaim Evidence Provenance — Imported from OpenClaw

> Per-claim provenance with evidence line-ranges so memory entities can trace back to specific source files and lines, not to a flat `source` string.

**Status**: Review-Convergence
**Converged**: 2026-05-07T00:00:00Z
**Author**: Echo (parallel OpenClaw audit, 2026-05-07)
**Date**: 2026-05-08
**Origin**: §8 #2 of `.claude/research/openclaw-audit-instar-2026-05-07.md`. OpenClaw source: `extensions/memory-wiki/src/markdown.ts:11-101`. Audited at OpenClaw commit `f482e4d335`.
**Related**: SemanticMemory, MemoryEntity, EpisodicMemory, EvolutionManager (bug-cluster claims), OPENCLAW-IMPORT-TASKFLOW-SPEC.md (consumer)

---

## Table of Contents

1. [TL;DR](#tldr)
2. [The Problem](#the-problem)
3. [The OpenClaw Primitive](#the-openclaw-primitive)
4. [Design Principles](#design-principles)
5. [Schema Changes](#schema-changes)
6. [Migration of Existing MemoryEntity Records](#migration-of-existing-memoryentity-records)
7. [Producers](#producers)
8. [Consumers](#consumers)
9. [Storage and Privacy](#storage-and-privacy)
10. [Migration Plan](#migration-plan)
11. [Risks and Mitigations](#risks-and-mitigations)
12. [Threat Model](#threat-model)
13. [Open Questions](#open-questions)
14. [Non-Goals](#non-goals)
15. [Review Decisions](#review-decisions)
16. [References](#references)

---

## TL;DR

Today, `MemoryEntity.source` is a single string like `"session:7c2f"` or `"user:Justin"`. That makes it impossible to answer questions like "what specific feedback report led us to flag this bug as critical?" or "which commit line teaches us this pattern?".

OpenClaw's `WikiClaim.evidence` is an array of `{kind, sourceId, path, lines, weight, confidence, privacyTier, note, updatedAt}` — every claim carries the receipts. Adding the same shape to Instar makes bug-cluster decisions, dispatch rationales, and pattern recognition auditable down to the source line.

This is a small schema add (one new optional column + one TypeScript type) with high downstream leverage. The bug-cluster pipeline (and the imported TaskFlow flows that consume it) is the primary motivating use case.

## The Problem

`MemoryEntity` (`src/core/types.ts:2580-2614`) has provenance as a flat string:

```typescript
source: string;          // 'session:ABC' | 'observation' | 'user:Justin'
sourceSession?: string;  // session id
```

Concrete failure modes today:

1. **Bug clusters can't trace to specific feedback reports.** A `pattern` entity for "Telegram messages with file paths get blocked by tone gate" lives with `source: "observation"` — which feedback IDs informed this pattern is invisible.

2. **Decisions can't trace to specific evidence.** A `decision` entity ("we use SQLite + JSONL dual-write for SemanticMemory") has no pointer to the original conversation lines or commit hashes that informed it. Re-evaluating the decision later requires reconstructing context manually.

3. **Lessons can't quote their teacher.** A `lesson` entity ("never bypass pre-commit hooks with --no-verify") is just text; the original Justin chat or commit-rejection log is lost.

4. **Cross-entity traceability is impossible.** "Show me everything that cites feedback report fb_abc123" is unanswerable today. Adding a typed evidence index makes it a single query.

The downstream consequence: when Justin asks "why did Echo decide X?", the honest answer is often "I don't have the receipts, just the conclusion." That's the gap WikiClaim evidence closes.

## The OpenClaw Primitive

Source: `extensions/memory-wiki/src/markdown.ts:11-101`.

```typescript
export type WikiClaimEvidence = {
  kind?: string;          // free-form e.g. 'feedback' | 'commit' | 'session' | 'document'
  sourceId?: string;      // foreign key to the source system (e.g. fb_abc123)
  path?: string;          // file path or URL
  lines?: string;         // line range, e.g. "42-58" or "73"
  weight?: number;        // 0-1 contribution weight
  confidence?: number;    // 0-1 trust in the source
  privacyTier?: string;   // 'public' | 'private' | 'sensitive' | ...
  note?: string;          // free-form annotation
  updatedAt?: string;     // ISO 8601
};

export type WikiClaim = {
  id?: string;
  text: string;
  status?: string;        // 'open' | 'verified' | 'contested' | 'retired'
  confidence?: number;
  evidence: WikiClaimEvidence[];
  updatedAt?: string;
};
```

WikiClaims live inside compiled wiki pages alongside other structured data (relationships, person cards). For Instar we are NOT importing the whole wiki layer — only the `WikiClaimEvidence` shape, applied to existing `MemoryEntity` records.

## Design Principles

1. **Evidence is per-entity, not per-store.** Each `MemoryEntity` carries its own evidence array. No global "evidence database" — that would create N+1 join problems for every retrieval.
2. **Evidence is append-only-mostly.** New evidence can be added; existing entries can have `updatedAt` refreshed; weights can be recomputed; but evidence entries are never destructively edited. Retire an evidence entry by adding a new entry with `kind:"supersedes-evidence"` pointing at the old `sourceId`.
3. **Evidence supplements, doesn't replace, `source`.** The legacy `source: string` stays for compatibility. New entities populate both; old entities populate `evidence: []` and keep `source` as the only signal.
4. **Privacy tier travels with evidence.** A `decision` entity may be public-scope but cite a private feedback report; the evidence entry's `privacyTier` controls whether that specific citation is visible to a given viewer.
5. **No LLM in the producer path.** Evidence arrays are populated by structural code (the feedback handler, the dispatch executor, the cluster builder), not by an LLM "extracting evidence" from text. Determinism + auditability.

## Schema Changes

```typescript
// src/core/types.ts

export type MemoryEvidenceKind =
  | 'feedback'
  | 'commit'
  | 'session'
  | 'document'
  | 'message'
  | 'job-run'
  | 'ledger-entry'
  | 'pattern-entity'
  | 'external-url'
  | 'supersedes-evidence';

export interface MemoryEvidence {
  /** Kind of source — typed, not free-form, for queryability */
  kind: MemoryEvidenceKind;
  /** Foreign key to the source system */
  sourceId: string;
  /** Optional file path or URL (relative to repo root or absolute URL) */
  path?: string;
  /** Optional structured line range — preferred over freeform `lines` */
  lineStart?: number;
  /** Inclusive end line; equal to lineStart for single-line citations */
  lineEnd?: number;
  /** Optional freeform line range, e.g. "42-58" or "73". Derived from lineStart/lineEnd when both present. Kept for OpenClaw shape parity. */
  lines?: string;
  /** Optional contribution weight (0-1) — how much this evidence informed the claim */
  weight?: number;
  /** Optional trust in the source (0-1) — separate from weight */
  confidence?: number;
  /** Optional privacy tier; defaults to entity's privacyScope. Narrowing-only at write time (see Privacy section). */
  privacyTier?: 'public' | 'shared-project' | 'private' | 'sensitive';
  /** Optional free-form annotation. Hard cap MAX_EVIDENCE_NOTE_BYTES = 500 bytes; longer notes are rejected at write time. */
  note?: string;
  /** ISO 8601 timestamp of when this evidence was added or last refreshed */
  updatedAt: string;
}

/** Per-entity cap; overridable up to 500 via SemanticMemoryConfig.evidenceCapPerEntity. */
export const DEFAULT_EVIDENCE_CAP_PER_ENTITY = 50;
/** Hard upper bound on evidence cap; values above this are clamped. */
export const MAX_EVIDENCE_CAP_PER_ENTITY = 500;
/** Hard cap on `note` field bytes. */
export const MAX_EVIDENCE_NOTE_BYTES = 500;

// Existing interface extension:
export interface MemoryEntity {
  // ... all existing fields ...

  /** Legacy source field — keep for compatibility */
  source: string;

  /** NEW: typed evidence array. Empty for legacy entities; populated for all new entities. */
  evidence: MemoryEvidence[];
}
```

Storage: a new SQLite table `entity_evidence`:

```sql
CREATE TABLE entity_evidence (
  evidence_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  lines TEXT,                 -- denormalized freeform fallback
  weight REAL,
  confidence REAL,
  privacy_tier TEXT,
  note TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_entity_evidence_entity ON entity_evidence(entity_id);
CREATE INDEX idx_entity_evidence_source ON entity_evidence(kind, source_id);
```

Two indexes: one for "what's the evidence for this entity," one for "what entities cite this source" (the inverse query — currently impossible).

**Foreign key enforcement**: SemanticMemory must execute `PRAGMA foreign_keys = ON` on every connection — better-sqlite3 does NOT default to ON. Without this pragma, `ON DELETE CASCADE` is silently ignored. Add a one-time assertion in `createSchema()` that the pragma is active.

**Transaction scope**: when a producer creates an entity *with* evidence in one logical operation, both writes MUST occur inside a single better-sqlite3 transaction (`db.transaction(() => { ... })`). The new API `rememberWithEvidence()` (see Producers) wraps both. `addEvidence(entityId, evidence | evidence[])` accepts an array and wraps the inserts in a single transaction so multi-evidence calls are atomic.

**JSONL representation**: evidence does NOT round-trip via the existing `appendToJournal('remember', ...)` action — that writes the entity row only. A new action `addEvidence` (and `rememberWithEvidence` payload variant) is required so JSONL replay reconstructs evidence faithfully:

```jsonc
// JSONL entry on entity create with evidence
{ "action": "rememberWithEvidence", "entity": {...}, "evidence": [...] }
// JSONL entry on later evidence addition
{ "action": "addEvidence", "entityId": "...", "evidence": [...] }
// JSONL entry on cascade-delete (already exists for entity)
{ "action": "forget", "entityId": "..." }   // evidence rows reconstructed as deleted
```

## Migration of Existing MemoryEntity Records

Existing entities have `source: string`. Migration strategy:

1. Add the table; no destructive changes to `entities`.
2. For each existing entity, leave `evidence: []`. Old `source` still answers "where did this come from at the coarse level."
3. A one-shot `instar memory backfill-evidence` command (idempotent) walks specific known patterns:
   - `source: "session:ABC"` → if session ABC exists in episodic memory, `evidence: [{kind:"session", sourceId:"ABC", updatedAt: createdAt}]`. If session ABC has been deleted/renamed, leave `evidence: []` and log a warning to `backfill-report.jsonl`. Synthetic `kind:"session"` entries pointing at dead sessions are NOT created.
   - `source: "user:Justin"` → `evidence: [{kind:"message", sourceId:"user:Justin", updatedAt: createdAt, confidence: 0.5}]` (low confidence reflects coarse provenance)
   - `source: "observation"` → leave `evidence: []` (no upgrade possible)
   - any other pattern → leave `evidence: []` and log to `backfill-report.jsonl`
4. New entities populate `evidence` from day one; the legacy `source` is auto-derived from the highest-weight evidence entry.

## Producers

> **Integration note (added in convergence)**: As of OpenClaw audit and verification against current Instar source, `EvolutionManager` (`src/core/EvolutionManager.ts:78`), `FeedbackManager` (`src/core/FeedbackManager.ts:31`), and `DecisionJournal` (`src/core/DecisionJournal.ts:32`) do NOT currently produce `MemoryEntity` rows. They write to their own JSON / JSONL stores. Producer integration in Phases 2–3 therefore requires a *new* bridge from each subsystem into `SemanticMemory.rememberWithEvidence()`, not a modification of existing entity-creation calls. For DecisionJournal specifically, the bridge promotes a `DecisionJournalEntry` to a `decision` MemoryEntity at log time; the journal entry retains its original JSONL row plus a back-reference `entityId`.

> **Cross-store sourceId integrity**: `kind:'feedback'` evidence cites a `FeedbackItem.id` that lives in `feedback.json`, not in the entities DB. Cross-store FK is best-effort: at write time the producer SHOULD verify the `sourceId` exists in its store; at read time consumers MUST tolerate dangling references. The inverse query returns the citation row regardless; renderers display "[source unavailable]" for missing referents.

> **Authorization (per-caller kind allowlist)**: `addEvidence` and `rememberWithEvidence` take an opaque `producer` capability token. Only specific subsystems may write specific kinds:
>
> | producer | allowed kinds |
> |---|---|
> | `EvolutionManager` | `feedback`, `pattern-entity`, `supersedes-evidence` |
> | `DispatchExecutor` | `pattern-entity`, `job-run`, `ledger-entry` |
> | `DecisionJournal` | `message`, `commit`, `ledger-entry`, `session` |
> | `/learn` skill bridge | `message`, `session` |
> | `external-url` | requires explicit `producer: 'manual'` and entity owner = caller user |
>
> Mismatches are rejected with `EvidencePolicyError`. The allowlist lives in `SemanticMemory` config, not as runtime checks scattered through callers.

### Bug-cluster builder
When EvolutionManager builds a cluster pattern entity, it cites every feedback report that fed into the cluster:

```typescript
const evidence: MemoryEvidence[] = clusterMembers.map(fb => ({
  kind: 'feedback',
  sourceId: fb.id,
  weight: fb.clusterContribution,
  confidence: fb.confidence ?? 0.8,
  privacyTier: fb.privacyTier ?? 'shared-project',
  note: fb.summary?.slice(0, 200),
  updatedAt: nowIso(),
}));
```

### Dispatch decision recorder
When DispatchExecutor records why a fix was attempted, it cites the cluster + the prior dispatch attempts:

```typescript
const evidence: MemoryEvidence[] = [
  { kind: 'pattern-entity', sourceId: cluster.entityId, weight: 0.6, ... },
  ...priorAttempts.map(a => ({ kind: 'job-run', sourceId: a.runId, weight: 0.1, ... })),
];
```

### Decision journal
When DecisionJournal logs a decision, it cites the conversation lines + commits + ledger entries that informed it:

```typescript
const evidence: MemoryEvidence[] = [
  { kind: 'message', sourceId: messageId, lines: lineRange, weight: 0.7, ... },
  { kind: 'commit', sourceId: commitSha, path: filePath, lines: changedLines, ... },
];
```

### Lesson capture (existing /learn skill)
The `learn` skill already captures lessons; it should require at least one evidence entry from the conversation:

```typescript
{
  type: 'lesson',
  content: '...',
  evidence: [{ kind: 'message', sourceId: msgId, weight: 1.0, ... }]
}
```

## Consumers

### Bug-cluster auditing
Query: "for cluster X, which feedback reports informed each tier-1-fix-attempt rationale?"
SQL:
```sql
SELECT e.evidence_id, e.source_id, e.weight, e.note
FROM entity_evidence e
WHERE e.entity_id = ? AND e.kind = 'feedback'
ORDER BY e.weight DESC;
```

### Inverse traceability
Query: "what entities cite feedback report fb_abc123?"
SQL:
```sql
SELECT e.entity_id, ent.type, ent.name
FROM entity_evidence e
JOIN entities ent ON ent.id = e.entity_id
WHERE e.kind = 'feedback' AND e.source_id = 'fb_abc123';
```

### TaskFlow integration
A flow's `stateJson.evidence: MemoryEvidence[]` records why each step was taken. When the flow finishes, the producing entity (e.g., the cluster pattern) inherits those evidence entries. This is how flow rationale persists past flow termination.

### Re-evaluation
A `decision` entity can be re-evaluated by querying its evidence and checking whether each evidence entry's `confidence` is still warranted. Stale decisions are then candidates for confidence decay.

### Privacy-scoped retrieval
When rendering an entity to a user with `privacyScope: "shared-project"`, the rendering layer filters evidence entries with `privacyTier: "private" | "sensitive"` from the rendered output. The entity's own privacyScope still applies.

## Storage and Privacy

- Evidence rows live in the same SemanticMemory database as entities.
- `privacyTier` defaults to the entity's `privacyScope` when omitted.
- **Narrowing-only constraint** (enforced at write time): evidence `privacyTier` may equal or be *more restrictive than* the entity's `privacyScope`, never less. Allowed transitions: `public → public|shared-project|private|sensitive`, `shared-project → shared-project|private|sensitive`, `private → private|sensitive`, `sensitive → sensitive`. Violations rejected with `EvidencePolicyError`.
- The renderer is the privacy-enforcement boundary, not the storage layer; storage keeps everything, renderer filters.
- **Inverse-query privacy filter**: `findEntitiesByEvidence` (renamed `findCitations` for DX) MUST filter by viewer scope before returning rows. A viewer at `shared-project` scope querying for citations of a `private` source receives only public/shared-project entities that cite it. Tests assert no leak via inverse query at every (viewerScope × evidence privacyTier × entity privacyScope) combination.
- JSONL append log includes evidence as separate `addEvidence` / `rememberWithEvidence` actions (see Schema Changes). Evidence is reconstructed by replaying the journal in order.
- Cascade delete: removing an entity removes its evidence (matches `ON DELETE CASCADE`, requires `PRAGMA foreign_keys = ON` — see Schema Changes). Evidence rows have no orphan lifecycle.

## Migration Plan

### Phase 1: Schema + types (one PR)
- Add `MemoryEvidence` type + table + JSONL representation.
- `MemoryEntity.evidence: MemoryEvidence[]` defaults to `[]`.
- All existing tests pass with `evidence: []` on legacy entities.
- Enable `PRAGMA foreign_keys = ON` per connection; assert it in `createSchema()`.
- New API:
  - `SemanticMemory.rememberWithEvidence(input, evidence: MemoryEvidence[], producer: ProducerId): string` — atomic create-with-evidence in one transaction.
  - `SemanticMemory.addEvidence(entityId, evidence: MemoryEvidence | MemoryEvidence[], producer: ProducerId): void` — appends; multi-evidence calls are atomic.
  - `SemanticMemory.getEvidence(entityId, viewerScope: PrivacyScopeType): MemoryEvidence[]` — viewer-scope-filtered.
  - `SemanticMemory.findCitations(ref: {kind: MemoryEvidenceKind; sourceId: string}, viewerScope: PrivacyScopeType): MemoryEntity[]` — viewer-scope-filtered (renamed from `findEntitiesByEvidence` for DX).
  - `SemanticMemory.getEntityWithEvidence(entityId, viewerScope): MemoryEntity & {evidence: MemoryEvidence[]}` — eager variant; default `getEntity` stays evidence-free.

### Phase 2: Producer integration — bug-cluster (one PR)
- EvolutionManager populates `evidence` for cluster entities.
- DispatchExecutor populates `evidence` for dispatch-decision entries.
- Backwards-compatible: old clusters/dispatches continue to work with `evidence: []`.

### Phase 3: Producer integration — DecisionJournal + /learn (one PR)
- DecisionJournal entries require at least one evidence entry.
- /learn skill prompts for evidence (or auto-derives from conversation context).

### Phase 4: Inverse-traceability queries (one PR)
- Server endpoints: `GET /memory/evidence/by-entity/:id`, `GET /memory/entities/by-evidence?kind=feedback&sourceId=...`.
- Dashboard: per-entity evidence panel, "what cites this?" reverse view.

### Phase 5: Backfill + render hardening (one PR)
- `instar memory backfill-evidence` command.
- Renderer privacy filtering across all evidence-rendering paths.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Evidence array becomes a dumping ground** | Hard limit per entity (e.g., 50 evidence entries, configurable). Beyond that, oldest-by-`updatedAt` are dropped to a JSONL archive. |
| **Privacy leakage via evidence rendering** | Renderer-side filter is the single enforcement point. Add a test that renders every privacyScope × privacyTier combination and asserts no sensitive evidence reaches lower-scope output. |
| **Migration miscategorizes legacy `source` strings** | Backfill is idempotent and uses only the patterns enumerated above. Anything that doesn't match a known pattern stays `evidence: []`. No LLM in the migration path. |
| **Evidence weight inflation** | Weights are advisory, not enforced. The query layer can normalize within an entity (sum-to-1) at read time if needed. |
| **Schema bloat slows hot retrieval** | Evidence is loaded lazily — `getEntity` doesn't load evidence by default; `getEntityWithEvidence` is a separate call. The hot path stays cheap. Two new indexes add ~1.5–2x insert latency on the evidence table; benchmark in Phase 1 against the 10k-entity baseline. |
| **Backfill mislabels privacy** | Backfill defaults `privacyTier: undefined` (inherit from entity) for all migrated rows. No automatic upgrade to `private` or `sensitive`. |
| **`PRAGMA foreign_keys = OFF` silently breaks cascade** | Assert pragma is ON in `createSchema()`; integration test asserts cascade-delete actually deletes evidence rows. |
| **Supersedes-evidence cycles** | Cycle detection at write time bounded by `MAX_SUPERSEDES_DEPTH = 32`; renderer-side walks bounded by the same. |
| **Cross-store dangling sourceId** | Best-effort write-time check; consumers tolerate dangling refs by displaying "[source unavailable]" rather than throwing. |

## Threat Model

- **Spoofed evidence**: a malicious caller adds evidence pointing at a feedback ID that doesn't exist or pointing at someone else's commit. Mitigation: per-caller kind allowlist (see Producers section) enforced inside SemanticMemory; mismatches throw `EvidencePolicyError`. Cross-store FK is best-effort but spoofs are detectable at audit time by matching `sourceId` against the producer's own store.
- **Evidence explosion attack**: an attacker creates entities with thousands of evidence rows to bloat the DB. Mitigation: per-entity limit (`DEFAULT_EVIDENCE_CAP_PER_ENTITY = 50`, hard ceiling 500) + `MAX_EVIDENCE_NOTE_BYTES = 500` cap on `note` + per-caller rate limit (default 10 evidence/sec/producer, configurable).
- **Privacy bypass via evidence**: rendering an entity with public scope but private evidence reveals information about a private source. Mitigation: narrowing-only constraint at write time (Storage and Privacy section) + render-time filter + inverse-query viewer-scope filter + cross-product tests.
- **`note` field exfiltration**: free-form `note` is privacy-sensitive. Mitigation: 500-byte cap; notes inherit the entity's `privacyScope` unless overridden to a more restrictive `privacyTier` (narrowing-only). PII redaction is OUT OF SCOPE for v1; producers are responsible for sanitizing notes before write.
- **Supersedes-evidence cycle**: a malicious or buggy producer chains `kind:'supersedes-evidence'` rows so A → B → A. Mitigation: at write time, traverse the existing supersedes-evidence chain rooted at the new entry's `sourceId`; reject if traversal length > MAX_SUPERSEDES_DEPTH (default 32) or if the new entry's own `evidence_id` would appear in its own ancestor chain. Renderer-side cycle walks must also bound depth.
- **Renderer SSRF via `external-url`**: `kind:'external-url'` with arbitrary `path` could trigger fetches from a renderer that auto-resolves URLs. Mitigation: renderers MUST treat `path` for `external-url` as display-only — never auto-fetch. URL fetching is a separate, gated capability not implied by evidence.
- **Producer-crash partial-write corruption**: a producer dies mid-loop after writing 3 of 10 evidence entries. Mitigation: `addEvidence` accepts arrays and wraps them in a single better-sqlite3 transaction (Schema Changes section). Multi-evidence operations are all-or-nothing.

## Open Questions

1. **Should `weight` and `confidence` be auto-computed?** OpenClaw leaves them caller-set. Instar option: derive `confidence` from the source's own confidence (e.g., feedback's stated confidence). Recommendation: caller-set in v1; auto-derivation as a Phase 6 enhancement.
2. **Evidence for relationships (MemoryEdge), not just entities?** Edges have a `context: string` today. Should they also have `evidence: MemoryEvidence[]`? Recommendation: yes, but Phase 6 — start with entities to keep v1 small.
3. **Do we want a wiki-claim-style separate `claim` table per entity, or merge into entity?** OpenClaw separates because pages have many claims. Instar entities are themselves claims. Recommendation: merge — `MemoryEntity` *is* a typed claim with content + evidence; no separate `claim` table needed.
4. **Should evidence be searchable via FTS5 / vector?** Yes for `note`; no for `sourceId` (exact match only). Recommendation: index `note` in the existing entity FTS table as a secondary column.
5. **Cross-agent evidence**: when Echo cites a Threadline message from Dawn, what does `sourceId` look like? Recommendation: `threadline:<threadId>:<messageId>` as a typed key matching Threadline's own ID format.

## Non-Goals

- **Not importing the wiki vault layer.** No deterministic page structure, no compiled digests, no Obsidian compatibility, no `wiki_search` / `wiki_apply` / `wiki_lint` tools. Just the evidence shape on existing entities.
- **Not retroactively populating evidence via LLM extraction.** Backfill is structural-pattern-only.
- **Not exposing raw evidence in conversational replies.** Renderer respects privacy. Evidence is for audit and re-evaluation, not for "show your work" in chat.
- **Not a replacement for git provenance.** Commits + commit messages are still the source of truth for code changes; evidence cites them, doesn't replace them.

## Review Decisions

Round 1 of multi-angle review (security, scalability, adversarial, integration, supply-chain, data-modeling, DX) flagged 4 blockers and 11 majors. The spec has been amended in place to address all blockers and most majors. Decisions where the spec deliberately declined a reviewer recommendation are recorded here for traceability:

- **PII redaction in `note`**: declined for v1. Cap is structural (500 bytes), not semantic. Producers are responsible for sanitization; redaction-as-service is a Phase 6 enhancement.
- **`lines` as freeform string**: kept alongside structured `lineStart`/`lineEnd` for OpenClaw shape parity. Range queries (e.g., "evidence touching line 50") are explicitly out of v1 scope; they require both structured columns to be populated, which producers may opt into.
- **Producer authorization via opaque token**: declined a JWT-style scheme; the producer ID is a process-internal symbol (e.g., the class instantiating SemanticMemory passes its own `producer: ProducerId`). Cross-process spoofing is not in the threat model — the threat is *bug-class* mis-citation, not adversary-class.
- **`weight` and `confidence` semantics**: kept caller-set, distinct, both 0-1. Auto-derivation deferred to Phase 6 per Open Question #1.
- **Edges (`MemoryEdge.evidence`)**: deferred to Phase 6 per Open Question #2.
- **Eager-vs-lazy default**: kept lazy (default `getEntity` does not return evidence). Reviewer suggested eager-by-default for simplicity; declined because the dashboard render path lists 100s of entities at once and N+1 evidence loads would be the dominant cost.
- **Inverse query name**: renamed `findEntitiesByEvidence` → `findCitations` for DX. Old name retained as a thin alias for one minor release.

## References

- OpenClaw: `extensions/memory-wiki/src/markdown.ts:11-101` (commit `f482e4d335`, verified 2026-05-07)
- Echo audit: `.claude/research/openclaw-audit-instar-2026-05-07.md` §3, §8 #2
- Instar adjacent: `src/core/types.ts:2580-2614` (MemoryEntity), `src/memory/SemanticMemory.ts`
- Related spec: `OPENCLAW-IMPORT-TASKFLOW-SPEC.md` (consumer for flow-rationale evidence)

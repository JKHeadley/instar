---
title: "Activity-digest entity extraction — populate SemanticMemory from mid-session work"
slug: "activity-digest-entity-extraction"
author: "echo"
review-convergence: "single-iteration"
review-iterations: 1
convergence-note: "Retrospective single-iteration convergence: the missing-link diagnosis was concrete (SessionActivitySentinel.ts line 268's `// future` comment) and the design is mechanically narrow (one new SemanticMemory helper + sentinel prompt extension + a private two-pass materializer). Rollback is a single revert that returns the schema-compatible pre-fix behaviour. Lower-risk than the usual 5-iteration target — acceptable per the same standard applied to the Initiative Tracker spec (2026-04-18) and the heal-execpath-staleness fix (2026-05-21)."
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-22"
approval-note: "Approved via Telegram topic 9976 (topic-intent-layer): 'I agree with all recommendations. Please proceed' (2026-05-21) covering the five Phase 0 sequencing decisions including activity-digest entity extraction as Phase 0d; followed by 'Please continue' (2026-05-22) authorizing the implementation phase. The five recommendations confirmed: graph-first activation (Phase 0 before Topic Intent Layer), multi-arc v1, annotate-only authority for decision-reopen, hard dual-framework gate, default-on at setup."
---

# Activity-digest entity extraction

## Problem

`SessionActivitySentinel` already creates per-activity digests with summary, actions, learnings, significance, and themes via a fast-tier LLM call. The digest schema includes an `entities: string[]` field — but the implementation at `src/monitoring/SessionActivitySentinel.ts:268` is a hardcoded empty array with the comment `// Entity extraction is a separate step (future)`.

Result: even with the sentinel scanning, even with PROP-memory-architecture's typed knowledge graph shipped and the migration able to backfill canonical state, the graph stops growing the moment migration finishes. Every new conversation, every new decision, every new learning happens — and none of it lands in SemanticMemory.

Evidence: echo and luna both show 0-to-low entity counts even after migration (echo: 5; luna: 42), because the only source feeding the graph is the one-shot migration from MEMORY.md / relationships / canonical state / decision-journal. Once that's done, the graph is frozen.

## Solution

Extend the digest LLM call to also extract typed entities + edges, then materialize them via `SemanticMemory.remember()` + `SemanticMemory.connect()`. The entity IDs are persisted in the digest's `entities` field for traceability.

### Prompt extension

The existing prompt at `buildDigestPrompt` asks for a structured JSON response with five keys. Add a sixth: `entities`. Each entity has type (one of `fact | person | project | tool | pattern | decision | lesson`), name, content, optional `relationships` (array of `{to: name, relation: RelationType}`).

Example shape requested from the LLM:

```json
{
  "summary": "...",
  "actions": [...],
  "learnings": [...],
  "significance": 5,
  "themes": [...],
  "entities": [
    {
      "type": "decision",
      "name": "use Path A service-account OAuth for fetchDocument",
      "content": "Decided to use server-side OAuth (service account) rather than per-user OAuth for the backend fetch path. Search Action retains per-user OAuth. Rationale: simpler ops, faster pilot. Tradeoff: weaker per-user fetch authz; mitigated by upstream search filter.",
      "relationships": [
        {"to": "Egnyte refresh-token rotation", "relation": "constrained_by"},
        {"to": "GCI Phase 1 build", "relation": "part_of"}
      ]
    }
  ]
}
```

### Materialization

For each entity in the response:

1. Call `SemanticMemory.remember()` with the entity. The dedup step (lexical first, semantic if Phase 5 enabled) handles re-extraction across multiple digests — if "Tom Southam" shows up in 30 digests, we get one entity with high access_count, not 30.

2. For each relationship, look up the target entity by name. If found, call `SemanticMemory.connect()`. If not found in this batch, defer (write to a small pending-edges queue, retry on the next digest cycle).

3. Collect the resulting entity IDs into the digest's `entities: string[]` field for traceability.

### Source tagging

Every entity gets `source: 'session:<sessionId>'` and `sourceSession: <sessionId>` so the provenance chain back to the conversation is intact. Confidence starts at 0.7 (matches the MEMORY.md migration default — observation-grade, not user-asserted).

### Failure handling

The digest creation already handles LLM failure (pending queue, retry). Entity extraction failures should NOT block digest persistence — if the entities key is missing or malformed in the LLM response, log a warning, store the digest with empty entities, continue. The digest is still useful without entity extraction; degrading gracefully here matches the existing fail-open pattern.

## Components

**Modified files:**

- `src/monitoring/SessionActivitySentinel.ts` — extend `buildDigestPrompt` (new entities section), extend `parseDigestResponse` (parse + validate entities array), extract `materializeEntities` helper that calls SemanticMemory and records IDs.

**No new files needed.** SemanticMemory.remember/connect already exists.

**Schema impact:** none. The `entities: string[]` field already exists in ActivityDigest.

## Tests

**Unit (`tests/unit/SessionActivitySentinel-entity-extraction.test.ts`):**

- Prompt builder includes the entities section with valid JSON shape example.
- Response parser handles missing entities key (returns empty array, no throw).
- Response parser handles malformed entities (filters bad shapes, logs warning).
- Materializer calls SemanticMemory.remember for each entity, with the right type + content + source tag.
- Materializer connects entities by name within a batch; defers unresolved relationships to a pending queue.

**Integration (`tests/integration/digest-to-semantic-pipeline.test.ts`):**

- A real ActivityUnit with conversation + session-output content produces a digest whose `entities` field references real SemanticMemory entities.
- Re-running on the same unit dedups rather than duplicating (idempotent).
- Cross-digest: entity referenced in digest 1 and digest 2 yields ONE entity with access_count = 2.

## Acceptance evidence

Per the bug-fix-evidence memory: reproduce the failure mode (graph empty after migration despite ongoing work), apply the fix, verify entities materialize from real digest content.

The reproduction is already in hand from Phase 0a — both echo and luna show entity counts stuck after migration. Post-fix verification: run the sentinel scan on a session with recent activity, then check entity count goes up; re-check 30 minutes later, verify it continues to grow.

Live test: trigger a scan on luna (which has rich TopicMemory and active sessions), confirm new entities appear within one scan cycle.

## Decision-point inventory

1. **Pending-edges queue location.** Options: (a) in-memory only (lost on restart, easy), (b) persisted JSONL beside the digest store. Default: (a) for v1, since unresolved edges typically resolve within a few scan cycles. (b) is a follow-up if we see persistent unresolved-edge accumulation.

2. **Default confidence for digest-extracted entities.** Default: 0.7 (matches MEMORY.md migration). Alternative: 0.8 for entities whose content is grounded in conversation (vs. inferred). Verification needed before differentiating.

3. **Entity type cardinality.** SemanticMemory has 7 types (fact, person, project, tool, pattern, decision, lesson). Should the prompt restrict the LLM to a smaller subset to reduce noise? Default: ask for all 7, let the dedup step handle accidental overlap. If we see type-misclassification noise in the field, tighten.

4. **Token budget.** The digest prompt currently asks for 1500 max tokens. Adding entities will push that up. Default: bump to 2500 max and watch cost. If 2500 isn't enough for rich activity units, consider splitting entity extraction into a second LLM call (more expensive but cleaner separation).

5. **Cross-framework.** Sentinel reads tmux session output (Claude) and Telegram JSONL. Codex agents will have different session-output formats. The entity-extraction LLM call goes through `sharedIntelligence` so it's framework-agnostic on the LLM side. The session-output capture path is the same as today — out of scope for this spec.

## Out of scope (intentional)

- Wiring the sentinel's periodic scan loop (Phase 0b).
- Promoting entities to a global graph (Phase 0 is single-agent).
- Cross-topic retrieval at materialization time.
- Vector embedding generation (Phase 5 of PROP-memory-architecture, handled separately by `EmbeddingProvider` on remember()).

## Rollback

Single-commit revert. The new entity extraction degrades gracefully on its own (empty entities array on parse failure); reverting just removes the prompt extension and the materializer call. No data migration. Already-extracted entities stay in SemanticMemory and are valid records — revert affects future scans only.

## Origin

Topic 9976 (topic-intent-layer), 2026-05-21. Phase 0a investigation surfaced that the entity-extraction step is documented as future work in SessionActivitySentinel.ts line 268. The grounded-synthesis doc identified this as the single most impactful missing piece — without it the typed graph remains stuck at migration-backfill content, and the broader awareness layer has nothing to retrieve from.

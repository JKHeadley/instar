# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new agent-facing capability without breaking changes -->

## What Changed

**feat(memory): activity-digest entity extraction — populate SemanticMemory from ongoing work.**

`SessionActivitySentinel` already wrote per-activity digests (summary, actions, learnings, themes) via a fast-tier LLM call after every chunk of session activity. The digest schema had an `entities: string[]` field — but the implementation was a hardcoded empty array with a `// future` comment. After the one-shot migration from MEMORY.md / relationships / canonical state / decision-journal completed, SemanticMemory stopped growing. Every conversation, every decision, every lesson learned landed in conversation logs but never in the structured graph the agent actually queries.

This release extends the digest LLM call to also extract typed entities (one of `fact`, `person`, `project`, `tool`, `pattern`, `decision`, `lesson`) plus relationships between them (one of the 11 RelationType enums). Extracted entities are validated, deduped against the existing graph by case-insensitive name+type match, written via `SemanticMemory.remember()` with `source: 'session:<id>'` provenance, and connected via `SemanticMemory.connect()` for both intra-batch and cross-digest references.

Architecture:

1. The digest prompt now asks for a sixth JSON key (`entities`) with type+name+content+relationships, alongside an enumeration of the valid types and a short rule about what's worth remembering ("durable things worth recalling weeks later, not every noun").

2. `parseExtractedEntities` validates each item against the type enum; malformed entries are dropped with a log warning rather than failing the whole digest. Relations with unknown verbs are filtered out before reaching `connect()`.

3. `materializeEntities` runs two passes — first remembering all entities (deduping via the new `findByName` SemanticMemory helper), then resolving relationships through the batch name→id map. Cross-digest references resolve through `findByName` against the persisted graph. Unresolved targets are dropped silently; they re-resolve when a future digest mentions both names together.

4. `SentinelConfig.semanticMemory` is optional. When unset (no SemanticMemory subsystem in this install), the sentinel falls through to the pre-existing behaviour: digests are persisted with `entities: []`. Graceful degradation; no breakage.

5. Confidence is set to 0.7 for all digest-extracted entities, matching the MEMORY.md migration default. This reflects observation-grade certainty (the LLM extracted from real session content), not user-asserted certainty (which would be 0.95).

Fail-open semantics throughout: extraction failures NEVER block digest persistence. The digest's summary/actions/learnings/themes are the canonical record; entities are an enrichment that degrades quietly when the LLM or the storage layer aren't cooperating.

## Evidence

7 new unit tests in `tests/unit/SessionActivitySentinel-entity-extraction.test.ts` against real SemanticMemory + EpisodicMemory (no mocks, per the verify-against-real-APIs memory):

1. Prompt shape — the digest prompt now requests entities with the JSON shape and the type+relation enumerations.
2. End-to-end — a digest LLM response with 2 entities produces 2 SemanticMemory records with `source: session:<id>` provenance.
3. Cross-digest dedup — same entity name in digest N and digest N+1 yields ONE entity with the original ID, not a duplicate.
4. Intra-batch relationship resolution — entity A's relationship to entity B (both in the same batch) creates an edge.
5. Malformed-entity safety — bogus types / missing content / unknown relation verbs are dropped; valid entries in the same batch still materialize.
6. Graceful degradation without SemanticMemory — digest still persists with `entities: []`; no crash.
7. Missing-entities-key tolerance — older LLM responses (or any response that omits the key) still produce a digest.

All 21 existing `session-activity-sentinel.test.ts` tests still pass — no regression.

## What to Tell Your User

Your agent now builds up a structured memory graph as it works. Over the next few days, you'll notice the agent's context at the start of new sessions getting richer — it'll know about more of its own prior work without needing to dig through transcripts. Decisions made in past sessions, people you've discussed, projects and tools — anything worth remembering durably — becomes searchable and connectable.

Nothing is required from you. The graph builds quietly in the background through the activity sentinel that's already running.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Automatic entity extraction from session activity | Automatic — runs in every digest scan when SemanticMemory is enabled |
| Cross-digest entity dedup | Automatic — same name + same type collapses to one entity |
| Typed graph edges from intra-batch and cross-digest references | Automatic — emitted when target entity is in scope |

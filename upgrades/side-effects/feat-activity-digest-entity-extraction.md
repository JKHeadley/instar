# Side-Effects Review — feat(memory): activity-digest entity extraction

**Branch:** `echo/phase-0d-activity-digest-entities`
**Origin:** Phase 0d of the topic-intent-layer thread (Telegram 9976). Approved by Justin via the "Yes please" / "Please proceed" handoff on 2026-05-21 + 2026-05-22.

## Summary

`SessionActivitySentinel.digestUnit` was creating activity digests with `entities: []` hardcoded — line 268 carried a `// future` comment. SemanticMemory was shipping but had no automatic write path after the initial migration. This change extends the digest LLM prompt to also extract typed entities + relationships, validates them, and writes them to SemanticMemory with provenance back to the source session.

## Files touched

- `src/memory/SemanticMemory.ts` — added `findByName(name, type?)` helper for cross-digest dedup.
- `src/monitoring/SessionActivitySentinel.ts` — extended `SentinelConfig` with optional `semanticMemory`; extended `buildDigestPrompt`, `parseDigestResponse`; new `materializeEntities` and `parseExtractedEntities`.
- `src/commands/server.ts` — wired `semanticMemory` into the sentinel constructor, conditional on the SemanticMemory subsystem being enabled.
- `tests/unit/SessionActivitySentinel-entity-extraction.test.ts` — 7 tests covering prompt shape, dedup, intra-batch edges, malformed-entity skip, missing-key tolerance, graceful degradation without SemanticMemory.
- `docs/specs/activity-digest-entity-extraction.md` — spec.
- `docs/specs/activity-digest-entity-extraction.eli16.md` — ELI16 companion.
- `upgrades/NEXT.md` — release notes entry.

## Over-block check

The materializer runs only when `semanticMemory` is wired AND the LLM returned at least one entity. Empty arrays, missing keys, and malformed responses all short-circuit. No new code runs in the healthy-but-no-extraction path.

Existing sentinel callers that build a SessionActivitySentinel without `semanticMemory` continue to work — the field is optional. The Phase 0 startup path in `server.ts` only passes it when SemanticMemory was successfully constructed; if SemanticMemory degraded (e.g., better-sqlite3 issue), the sentinel falls through to the pre-fix behaviour.

## Under-block check

Could a future caller bypass the validator? `parseExtractedEntities` is private and called from `parseDigestResponse`. The entity-type and relation-type allowlists are local `readonly` arrays. Adding new types to either enum requires updating this list — if a future entity type is added to `EntityType` without the list update, the extractor will silently drop those entries. That's the safe direction (drop rather than crash) and the failure mode is observable (no entities of that type appear in the graph).

## Level-of-abstraction fit

`materializeEntities` lives inside the sentinel because that's where the digest LLM call lives — the extracted entities are a property of the digest, not a separate system. `findByName` lives on SemanticMemory because it's a primitive entity-lookup operation that other consumers (migration, future debug tools) will want too.

The materializer does NOT do its own LLM calls or schema inference. It accepts pre-validated typed structures and translates them into SemanticMemory.remember + connect calls. Pure plumbing, no policy.

## Signal-vs-authority compliance

The LLM extracts entities (signal). The validator rejects malformed structures (filter). The materializer writes only valid entities (authority). At no point does a brittle filter (regex, format match) decide what becomes a permanent record — every record goes through a typed-shape validator AND has provenance back to a specific session for audit.

If a future operator finds that the extractor's confidence threshold needs tuning, the entry point is `materializeEntities` (the authority), not the prompt or the validator. Same shape as CoherenceGate's signal-vs-authority pattern.

## Interactions

- **SemanticMemory.remember + connect**: existing public APIs, no behavior change. `findByName` is new but follows the same pattern as `findBySource`.
- **EpisodicMemory.saveDigest**: unchanged signature; the digest still saves with the entity-ID array as the `entities` field (previously always empty).
- **WorkingMemoryAssembler**: reads from SemanticMemory unchanged. The assembler now has a denser graph to retrieve from — pure quality improvement, no contract change.
- **Sentinel periodic scan / sessionComplete synthesis**: unchanged behaviour. Digest creation still proceeds even when entity extraction fails (the digest is the primary record).
- **PostUpdateMigrator**: unchanged. Migration backfills are independent of this pipeline.

## Cross-framework portability (v1.0+)

The digest LLM call routes through `IntelligenceProvider` (the framework-aware `sharedIntelligence`). Same call shape for Claude and Codex. The entities prompt is plain English asking for a JSON shape — both Haiku and gpt-5.2 handle it.

The capture path (tmux session output + Telegram JSONL) is unchanged from the pre-fix sentinel. Codex agents with a different session-output shape will see degraded extraction (smaller / noisier digests) but won't fail — that's an orthogonal improvement.

## Telemetry / observability

- Failed extraction logs a single warn line per failure (rate-limited by occurrence, not time).
- Digest persistence is unchanged — the existing `[ActivitySentinel] Session synthesis created` log still fires.
- `SemanticMemory.stats().totalEntities` and `totalEdges` will now grow with active sessions; that's the user-visible signal that the pipeline is working.

## Rollback

Single-commit revert. The new materializer is purely additive — reverting removes it, the digest schema still permits the (now-empty) `entities` field, and existing entities in SemanticMemory remain valid records. No data migration needed.

Already-extracted entities don't become orphans on rollback — they retain their `source: session:<id>` and `sourceSession` fields, and stay searchable / connectable like any other entity. They simply stop growing.

## Follow-ups (tracked, not orphaned)

1. **Confidence calibration.** v1 ships at 0.7 for all digest-extracted entities. Future work could differentiate by entity type (decisions → 0.6 because they may be revised, facts → 0.75 because they're observation-grounded).

2. **Pending-edges queue.** Currently unresolved cross-digest relationship targets are dropped silently. If we see meaningful edge loss in practice, the spec calls for a small JSONL-backed pending-edges queue that retries on subsequent scans.

3. **Cross-topic decay re-verification.** Entities first seen in one topic that get re-mentioned in another should bump `lastVerified` (treating cross-topic recurrence as light verification). Not in this commit; tracked as an enhancement to `findByName` callers.

Both items are tracked as initiatives, intentionally out of scope here.

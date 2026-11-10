# Side-Effects Review — Chunks on span close, the span sampler, C2 ranges, the PostCompact path and the chunk lookup routes (Phase 1 S8)

**Version / slug:** `cb-chunks`
**Date:** `2026-11-10`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** `Fable 5.2`

## Summary of the change

Phase 1 slice S8 of `docs/specs/context-budget-layered-summaries.md` (§6 rows C and C2 and the author/as-of rule, §6.5, §7.6, §8's authorship rule, §9.1, §9.5, §12's sampler rows). Stacked on S4 (topic-intent layer), which stacks on S1 (layer store).

New modules under `src/monitoring/contextLayers/`:

- **`spanSampler.ts`**: the deterministic sampler (floor, message ids, agent prose, errors, span tail, file-path results newest-first; default 30K tokens; per-entry edge cut; in-band disclosure), plus the normalization from Claude Code JSONL lines to archive entries and from archive entries back to sampler entries, so a span re-read from the archive samples exactly as it did when first read. Reusable for Phase 2 probe generation.
- **`chunkBuilder.ts`**: the coverage watermark (a machine-local `watermark` sidecar in the layer store), the streaming transcript span reader (cut at the last compaction boundary, bounded per build), the archive → pending chunk → watermark → summarize sequence, the strict validators, the pre-layer chunk, the C2 range builder, per-topic serialized fire-and-forget builds.
- **`chunkLookup.ts`**: the bounded, paginated list and single-record reads behind the routes.

Modified:

- **`LayerStore.ts`**: a new derived type `watermark`, mapped to `null` in `REPLICATED_TYPE` (never replicated).
- **`pruneContextArchive.ts`**: the Disk Steward floor also protects a `pending` chunk's span (the only copy its summary can be built from).
- **`routes.ts`**: `RouteContext.chunkBuilder`; the PostCompact route enqueues one build after the response when the layers, the builder and `compactionRecovery.enabled` are all on (its response gains `chunk: enqueued | off | no-transcript-session`); `GET /topic/:id/chunks`, `GET /topic/:id/chunks/:k`; `GET /context-budget/layers` gains `chunks`.
- **`AgentServer.ts`**: the `chunkBuilder` option.
- **`server.ts`**: constructs the builder next to the capture loop over the queued shared intelligence (background lane, the queue's daily cap), with TopicMemory lookups for message ids and the pre-layer pointer, feature evidence on outcomes, and a degradation if wiring throws.
- **`CapabilityIndex.ts`**: the two routes on the `contextBudget` row.
- **LLM component registries** (`componentCategories.ts`, `llmBenchCoverage.ts`, `provenanceCoverage.ts`, `docs/LLM-ROUTING-REGISTRY.md`, and the ratchet baselines in `llm-bench-coverage-ratchet.test.ts`, `parser-contract-classification-ratchet.test.ts` and `provenance-coverage-ratchet.test.ts`): the new component `ContextLayerChunk` is registered as a reflector, untrusted-input, not a judge, no parser contract, injection-exposed to all three content kinds, bench coverage and provenance enrolment pending (graded by the Phase 2 fold probes until a bench task lands <!-- tracked: CMT-1536 -->).

## Decision-point inventory

- **Chunk build admission** (add). Whether to spend one model call on a span: the layers' `LayerUpdate` budget decides; denied ⇒ pending and counted. Decides spend only.
- **Chunk output validation** (add). Accept or refuse a model output. Refused ⇒ pending. Decides what is written to a derived layer only.
- **C2 range close** (add). A threshold over the agent's own records.
- **PostCompact enqueue** (modify). The route adds a background enqueue after its response; the response itself and the record are unchanged in behaviour.
- **Disk Steward floor** (modify). One more status protected from eviction.

---

## 1. Over-block

- Nothing here blocks a message, a session or a hook. A deferred or refused chunk is `pending`, visible on the record, the list route and the builder's counts.
- The floor change can only keep more bytes: a pending span is never evicted. Bounded by the attempt ceiling: after six failed attempts the span stays protected until it closes; a topic with many permanently pending chunks would hold its archive bytes. Visible via the routes; recorded as a Phase 1 soak item <!-- tracked: CMT-1536 -->.

## 2. Under-block

- **Paraphrase of an operator sentence without quotation marks cannot be detected deterministically.** The prompt forbids it and the validator refuses any 12+ character quotation that is not byte-identical to the sampled span. An unquoted paraphrase would still land in a derived field labelled `author: derived`. The spec's stage verifier (§7.5) is the second line for anything a packet carries; chunks are not yet rendered into a packet (S9/S10).
- **Message ids are matched by exact operator text inside the span's time window (±1 min).** An operator turn whose stored text differs from the injected text (edited, truncated) gets no message id; the chunk still carries its entry range.
- **The scrub.** The model sees only the ARCHIVED span, which is scrubbed on write and again on read (shape patterns plus the agent's own live values). Same residual as S1/S4: an unshaped third-party secret can reach the conversation's own model path, which already saw the transcript.

- **The §7.6 `privacy_scope` filter is not applied to the chunk routes in this slice.** The routes are bearer-only and refused to memory-session tokens (not on the session guard's allowlist), so only the owner's token reads them; a chunk's summary could still reflect a private-scope message's content. The owner-visible projection filter lands with the transcript and messages routes, which need the same projection <!-- tracked: CMT-1536 -->. This is a declared deviation from §7.6 for Phase 1.

## 3. Level-of-abstraction fit

- The builder sits beside the layer store and archive it writes, with the model behind the injected `IntelligenceProvider` (the same queued wrapper the capture loop uses) and the spend behind the layers' shared budget. The route only resolves the session and enqueues.
- The sampler is a pure function over the archive's own entry shape, so the Phase 2 probe generator reuses it without a transcript.

## 4. Signal vs authority compliance

Chunks and ranges are derived summaries for later lookup. They hold no authority over any message, session or user, and nothing reads them to decide anything yet (H3 is S9). Not a brittle blocking check.

## 4b. Judgment-point check

- The sampler ceiling (30K), the C2 thresholds (~20 chunks / ~8K tokens), the per-build entry cap (4,000), the retry counts (two per trigger, six attempts) and the per-entry cut (4,000 chars) are the spec's cost defaults or bounds that name their consequence (a capped build continues at once in the same build, up to 10 continuations; nothing is skipped). They are not judgments over live signals and are tracked as Phase 1 soaks to be revised from measured spend <!-- tracked: CMT-1536 -->.

## 5. Interactions

- **The PostCompact route.** The enqueue is gated on `ctx.contextLayers`, `ctx.chunkBuilder` and `contextBudget.compactionRecovery.enabled` (live config first, then the boot config; omitted ⇒ on, as the spec's default). The transcript path resolution (which can fork tmux for the config home) runs in `setImmediate` after the response. A resolution failure is reported as a degradation.
- **CompactionSentinel and the standing packet.** Untouched. This slice does not rebuild H1/H3 or the packet (S9/S10).
- **The LlmQueue.** Builds use the background lane and its daily cap; chunk calls compete with the capture loop and Usher there.
- **The event loop.** The transcript is streamed (`readline`), never loaded whole. `archiveSpan` gzips synchronously (bounded by the per-build entry cap) off the request path.
- **The Disk Steward.** The prune child reads chunk `status` and `spanIds` through `currentPhaseSpans`; pending spans are now on the floor.
- **Replication.** Chunk and C2 records replicate through the layer kind (dark until `stateSync.contextLayers`); the watermark never does.

## 6. External surfaces

- Two new read routes, bearer-only, not on the memory-session allowlist, bounded, 503 when the layers are off.
- The PostCompact response gains a `chunk` field (additive).
- `GET /context-budget/layers` gains `chunks` (additive).
- A new degradation id `contextBudget.layers.chunks`.
- No new switch, no outbound messages, no dashboard change.

## 6b. Operator-surface quality

Not applicable. No dashboard file is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Chunk and C2 records: unified**, through the layer kind, dark until `stateSync.contextLayers` is on.
- **Archive and watermark: machine-local by design.** Each machine archives and chunks its own sessions' transcripts (§14 "owner-acts"); a span's state on another machine reads `unknown` until the proxied transcript route lands. The watermark follows the transcript it indexes, so it is never replicated.
- **Budget: machine-local**, as in S4.

## 8. Rollback cost

- `contextBudget.enabled: false` removes the builder and the routes (503) at the next restart. `contextBudget.compactionRecovery.enabled: false` stops the enqueue immediately (read per request).
- Records already written stay on disk under the layer store and archive; the Disk Steward retention still governs the archive.
- A release revert is clean: additive fields and files, no migration.

## Conclusion

S8 makes the PostCompact path archive the compacted span and summarize it into a chunk through the spec's sampler, keeps every gap visible and retried, adds C2 ranges and the lookup routes, all behind the dev-gated layers switch and the compaction-recovery switch.

## Second-pass review (if required)

**Reviewer:** Fable 5.2

**Independent read of the diff:** concur with changes. Two blocking items and ten should-fix items; all blocking and should-fix items are fixed in this commit except S9, which is declared.

Blocking, fixed:

1. **The watermark could move past an archived span no chunk covered.** If the build died (or the pending write failed) between archiving a span and writing its pending chunk, the next trigger saw every entry deduplicated (`empty`) and advanced the watermark: a silent gap. The `empty` branch now resolves the holding spans from the archive index and writes a pending chunk for any span no chunk lists, before the watermark moves (`adoptOrphanSpans`). Test: the pending write fails once; the next trigger adopts the span and closes it.
2. **The quotation check refused ordinary prose.** The regex paired the closing quote of one short quotation with the opening of the next. Quotations are now paired open/close in order (`quotationsIn`) before the 12-character rule. A retry after a refused output now tells the model why and asks for no quotations. Tests: two short quotations pass; the retry prompt carries the hint.

Should-fix, fixed:

- **S1.** Attempts count only model calls that ran (failed or refused); a budget deferral or a missing model never uses one up.
- **S2.** A capped build continues at once in the same build (bounded at 10 continuations) instead of waiting a compaction per 4,000 entries.
- **S3.** One watermark per transcript (keyed by the engine session), so alternating sessions never reset each other.
- **S4.** With no boundary after the span's start, the read goes to the end, so a hook that fires before the boundary is flushed never chunks one compaction late.
- **S5.** Ledger- and anchor-named messages are on the sampler floor (`floorMessageIds` from the protected records' rows).
- **S6.** Message ids bind by equality after the channel prefix (or containment for rows of 20+ characters), so "ok" never binds to an unrelated turn.
- **S7.** A range takes only the contiguous closed run after the last range (stops at a pending chunk); a lost member stamp is repaired from the range's `chunkKeys` before any new range is counted.
- **S8.** The list route reads the archive index once per request.
- **S10.** The PostCompact path prefers the hook's own session id (the transcript that just compacted).

Nits, fixed: `npm ERR!` now matches the error tier; the floor comment says what the code does; the span data block uses a per-span delimiter; C2 input carries each chunk's open threads; the validator's bounds are closer to the prompt's.

Recorded, not fixed <!-- tracked: CMT-1536 -->:

- **S9, the §7.6 privacy filter** (see section 2).
- `archiveSpan` gzips synchronously off the request path (bounded by the per-build cap); to be timed on a real span in the Phase 1 soak.
- The pre-layer pointer sees only the last 2,000 topic messages; on a longer topic it reads `null` (unknown), never a wrong id.
- `looksLikeError` is a broad word match; it only orders the sample (the error tier comes before the tail), never drops a floor item.
- With no boundary after the watermark the read goes to the end, so a duplicate PostCompact delivery chunks part of the live tail early: a small early chunk, nothing skipped or double-counted.
- A chunk stuck at the attempt ceiling stops later ranges on that topic (a range takes only the contiguous closed run); visible on the list route; part of the Phase 1 soak.
- The pre-layer pointer and the fixed `<chunks>` tag on the C2 prompt (its input is validated model output) are left as nits.

**Resolution check (same reviewer):** first pass did not concur. Every item was resolved or adequately declared except B1, which was partial: adoption ran only when every entry was already archived, so an orphan span mixed in with new work at the next compaction (the common case) was still passed silently. Fixed: the success path adopts orphans whenever the archive deduplicated any entry, before the new span's pending chunk (so the orphan keeps the lower sequence), and aborts without moving the watermark if adoption fails. Test: the pending write fails once, new work and a second boundary are appended, the next trigger yields two closed span chunks. New issue N1 (an unreadable span held a retry slot forever) fixed: that case now counts toward the attempt ceiling. N2–N4 recorded above or corrected in this artifact. The reviewer's stated condition for concurrence was closing B1's mixed case, which this commit does.

**Final check (same reviewer): concur.** B1 and N1 confirmed resolved in the code. One new defect from the B1 fix, N5 (should-fix): the mixed path treated the span it had just archived as an orphan, writing a throwaway pending record and making a second model call for it. Fixed in this commit: `adoptOrphanSpans` skips the current span; the mixed-case test now asserts contiguous sequence numbers and exactly one model call per span.

## Evidence pointers

- **Unit:** `tests/unit/context-layer-chunks.test.ts` (30 tests): sampler order, floor (entry and ledger-named), the 30K ceiling, edge cuts, determinism, in-band disclosure; validators (bad JSON, extra fields, unfaithful and paired quotations); the watermark never skipping an entry (capped continuation, boundary cuts, per-transcript watermarks, orphan adoption in both the all-archived and the mixed case); pending on budget denial, no model, failed call and refused output with retry and the attempt ceiling; the Disk Steward floor (pending, open, current-phase vs closed); the pre-layer chunk once; C2 on the chunk and token thresholds, the contiguous run and stamp repair; message-id binding; the lookup helpers. Ratchets run green: topic-ref, no-silent-fallbacks, no-silent-llm-fallback, feature-ladders-coverage, CapabilityIndex, post-compact-store, llm-attribution, llm-bench-coverage, judges-claims, untrusted-input, parser-contract, provenance-coverage, routing-registry-freshness, routing-nature, injection-exposure (184 unit tests across the run). `tsc --noEmit` clean.
- **Integration:** `tests/integration/context-layer-chunks.test.ts` (3 tests, real AgentServer, a real Claude Code transcript fixture): a PostCompact POST enqueues exactly one build and the span flows archive → chunk → routes; the switch off enqueues nothing; 503, bearer, bad ids, unknown keys, the page cap. `post-compact-route`, `context-layer-store` and `context-layer-topic-intent` integration files still pass.
- **E2E:** `tests/e2e/context-layer-chunks-alive.test.ts` (3 tests): the production boot path with the layers on produces an archive entry and a chunk that `GET /topic/:id/chunks` serves; a fleet agent gets 503 and nothing on disk; WIRED source checks on server.ts, AgentServer.ts, routes.ts and the CapabilityIndex. The S1/S4/Phase 0 e2e files still pass.

## Class-Closure Declaration (display-only mirror)

Not a defect fix. Class `n/a`, closure `n/a`.

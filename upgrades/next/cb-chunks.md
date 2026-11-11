<!-- bump: patch -->
## What Changed

Chunk summaries, the span sampler, range summaries and the chunk lookup routes (context-budget-layered-summaries §6 rows C and C2, §6.5, §7.6, §9.5; Phase 1 S8). While `contextBudget.enabled` is on (dev-gated) and `contextBudget.compactionRecovery.enabled` is on (default on):

- **The PostCompact path archives and chunks.** After a compaction is recorded, the server resolves the session's transcript and takes the entries from the topic's coverage watermark (the first unchunked entry) up to the compaction boundary. It archives that span in the transcript archive (deduplicated by entry id) and queues exactly one chunk build. All of this happens after the hook has its response, so the hook is never slowed. With the recovery switch off, nothing is queued and the record stays observability only.
- **The deterministic span sampler.** One sampler for every raw-span read, reusable for Phase 2 probe generation. Selection order: floor items (never dropped), entries carrying message ids, agent prose, errors, the span tail, then file-path results newest-first. The default ceiling is 30K tokens, and the chunk carries "sampled from N entries" in-band.
- **Chunks.** One bounded model call per span, through the queued shared intelligence and admitted by the layers' budget, returning strict JSON (`attempted`, `outcome`, `artifacts`, `openThreads`, `summary`). The validator refuses malformed output and any quotation that is not byte-identical to the span, so a chunk never rewrites an operator sentence. A chunk carries its entry range, message ids, trigger, author and `spanIds`.
- **Gaps stay visible.** Budget denied, no model, a failed call or a refused output leaves the chunk `pending` with "unsummarized gap: entries X..Y, chunk pending". It is retried from the archive on the next trigger (two per trigger, up to six attempts). The Disk Steward never evicts a pending chunk's span.
- **The pre-layer chunk.** A topic's first chunk is preceded by one `pre-layer` chunk, written without a model call, pointing at the topic messages and the archive for the earlier history.
- **C2 ranges.** When about 20 closed chunks or about 8K chunk tokens sit outside any range, one budgeted call writes a range summary and stamps each member with its `rangeId`.
- **Lookup routes.** `GET /topic/:id/chunks` lists C and C2 records newest first, with sizes, status and each archived span's state (present, raw-evicted, unknown), paginated (default 50, at most 200). `GET /topic/:id/chunks/:k` returns one. Both are bearer-only, closed to memory-session tokens, and 503 while the layers are off. `GET /context-budget/layers` also shows the chunk builder's counts.

## What to Tell Your User

Nothing changes for you yet. On development agents, when a long conversation gets compacted, I now keep the part that was compacted away in a private archive and write a short summary of it, so older work can be looked up later instead of being lost. If a summary can't be written right away, the gap is marked and filled in next time.

## Summary of New Capabilities

- Chunk (C) and range (C2) summaries built from archived transcript spans on compaction.
- A deterministic, reusable span sampler with in-band sampling disclosure.
- `GET /topic/:id/chunks` and `GET /topic/:id/chunks/:k`.

## Evidence

- Unit: `tests/unit/context-layer-chunks.test.ts`.
- Integration: `tests/integration/context-layer-chunks.test.ts` (real AgentServer, a real Claude Code transcript fixture).
- E2E: `tests/e2e/context-layer-chunks-alive.test.ts`.

<!-- bump: patch -->
## What Changed

This adds H3, the long-term view, and makes it the single writer of the topic summary table (context-budget-layered-summaries §6 row H3, §6.5, §14; Phase 1 S9). It applies while `contextBudget.enabled` is on (dev-gated: live on development agents, off on the fleet).

- **H3 is rebuilt from a bounded selection, never the whole history.** The floor, never dropped, is every chunk not yet in a range (pending gaps included, labelled as gaps) plus the chunks of the current phase. Ranges are read newest first under a 24K-token input default: through their member chunks while budget allows, then through their range (C2) summary. The oldest ranges are left out only when even their range summaries do not fit. The record and the summary text say in-band which ranges were read through C2 or left out.
- **When it runs.** H3 rebuilds when a chunk or range closes, at most once per 10 minutes per topic; a request inside that window schedules one rebuild at its end. Each build is one model call on the shared background queue (daily cap), under the layers' `LayerUpdate` budget. If the budget is over or no model is available, the build is deferred and the previous view stands.
- **Guards on the model call.** The output must be strict JSON (a one-line purpose and a summary), and any quotation must be copied exactly from the input. A floor over the input budget asks once for a range close. Past a hard ceiling nothing is sent. An H3 too large to replicate is rebuilt once under a tighter range selection.
- **One writer for the topic summary.** Every write to the summary table now goes through one funnel (`TopicSummaryTable`), the only caller of `saveTopicSummary`. With the layers on, H3 writes the row: `lastMessageId` is the last message its selection covers, and `purpose` is H3's own derived line. The old rolling summary is kept as `h3/legacy-retired` before H3 first overwrites it.
  - `POST /topic/summary` returns `409 summary-written-by-h3` with a plain reason.
  - `POST /topic/summarize` returns the H3 text with `writer: h3` and its freshness, and never asks the caller to write.
  - The rolling `TopicSummarizer` is off.
- **With the layers off (the fleet default), nothing changes.** The summarizer and both routes behave exactly as before.
- `GET /context-budget/layers` gains `h3` counts. `GET /context-budget/metrics` gains a per-topic `h3` row: built or not, freshness, and how much was read through range summaries.
- CLAUDE.md gains a Registry-First row for the long-term view and the single-writer rule. New agents get it from the template and existing agents get it through `migrateClaudeMd`.

## What to Tell Your User

Nothing changes for you yet. On development agents, each conversation's long-term summary is now written in one place only. It is rebuilt from the short summaries of each stretch of work, so it no longer drifts or gets overwritten by a second writer. If a conversation has not been compacted yet, its older summary stays as it was until the first one is written.

## Summary of New Capabilities

- H3, the long-term view per topic, built from a bounded, disclosed selection of chunk and range summaries.
- A single-writer funnel for the topic summary table: H3 with the layers on, the legacy writers with them off.
- `POST /topic/summarize` returns H3 (`writer: h3`) and `POST /topic/summary` returns 409 while the layers are on.

## Evidence

- Unit: `tests/unit/context-layer-h3.test.ts`, `tests/unit/migrate-context-budget-h3-row.test.ts`.
- Integration: `tests/integration/context-layer-h3.test.ts` (real AgentServer, real TopicMemory, a real Claude Code transcript fixture).
- E2E: `tests/e2e/context-layer-h3-alive.test.ts`.

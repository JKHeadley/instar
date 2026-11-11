<!-- bump: patch -->
## What Changed

The topic-intent layer becomes the context-budget H1/H2 layer (context-budget-layered-summaries §6, §6.3, §6.4; Phase 1 S4). While `contextBudget.enabled` is on, five things change:

- **The H1/H2 records.** Every captured turn mirrors the awareness projection into the layer store. H1 is the current work. H2 is the current phase, written only once a phase exists (the active arc has run across at least two turns) and removed otherwise. Both carry their author and an "as of" stamp.
- **The freshness stamp in the briefing.** The topic-intent briefing now states `as of <time>, <n> messages behind`, computed against TopicMemory. A layer behind its target is marked stale, and an unknown distance reads "freshness unknown", never fresh.
- **Real brakes.** The topic-intent spec had these only in prose: a per-topic and a component daily token ceiling. Over a ceiling, a turn is deferred and counted (`budget_deferred`), never silently skipped.
- **Transcript-growth ticks.** A tool-heavy session that sends no messages still refreshes H1. A tick runs at most every 10 minutes (the interval grows with recent updates), is skipped mid-turn, and only fires when the transcript grew. It reads at most the last 12 tool names and the first and last 500 characters of each result, at most about 4K tokens, scrubbed before the call. The resulting H1 is tagged `origin: tool` with "N results sampled".
- **A loud degradation.** If capture cannot run on a machine (no shared intelligence), a degradation is reported instead of an empty briefing passing for a quiet one.

`GET /context-budget/layers` now also shows the budget and the ticker. `TopicMemory.countMessagesAfter` is new.

## What to Tell Your User

Nothing changes for you yet. On development agents I now keep a short "what we're doing right now" note for each conversation, refresh it during long stretches of tool work, and know how many messages it is behind. It also has hard limits on how much it spends.

## Summary of New Capabilities

- H1/H2 layer records with author and as-of; the freshness stamp in the briefing.
- Per-topic and component token ceilings for layer updates, with deferral counted.
- Transcript-growth ticks with bounded, scrubbed digests.

## Evidence

- Unit: `tests/unit/context-layer-cadence.test.ts`.
- Integration: `tests/integration/context-layer-topic-intent.test.ts` (real TopicMemory, TopicIntentStore, capture loop and briefing route).
- E2E: `tests/e2e/context-layer-topic-intent-alive.test.ts`.

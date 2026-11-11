<!-- bump: patch -->
## What Changed

The ContextBudgetSentinel gains its remaining Phase 1 rows (context-budget-layered-summaries §7.8, §17; Phase 1 S12). All of it stays behind `contextBudget.sentinel.enabled` (default off).

- **Layer freshness.** For each conversation with a live session on this machine, the sentinel reads how far its running summary (H1) is behind TopicMemory.
  - Over target (more than 2 user turns behind) on a conversation this machine owns: it asks the layer's own writer to rebuild, at most 3 times per stale episode, 30 minutes apart. Today that request re-runs the H1/H2 projection from the stored awareness when the awareness covers a newer message than the layer. The sentinel never writes a layer itself.
  - Still stale an hour into the episode, after a request: one Attention notice for that episode. The episode is durable, so a restart does not repeat the notice.
  - An unknown reading is counted and shown, and nothing is done about it. H3 reads `unavailable: h3-not-built`. Without the layers the row reads `unavailable: layers-off`.
- **Hold health.** A fold hold or fold marker whose fold record is gone or finished, older than a 15-minute grace period, is cleared loudly: a degradation row, plus the status. It runs through its own pool-shared SelfHealGate ladder (3 attempts, then one notice), so only the conversation's owner acts. The record is re-read immediately before the release. A hold whose record is live or unreadable, of unknown age, or unattributable is never cleared here.
- **Eligible conversation without a fold.** Observation only. Until the benefit estimator exists, a live conversation with no fold for a day reads `unknown: no-benefit-estimator` and is counted. It is never acted on.

All three appear in `GET /context-budget/sentinel` as `layerFreshness`, `holdHealth` and `eligibleWithoutFold`, with counts and at most 50 detail rows each. The CLAUDE.md Registry-First row for the sentinel names them, and existing agents get the row extended in place.

## What to Tell Your User

Nothing changes unless the context-budget watcher is switched on. When it is on, it also notices when a conversation's running summary falls behind and asks for a refresh. It tells you once if a refresh doesn't catch it up. It also clears any leftover "pause" from a fold that has already ended, so replies are never held back by a stale marker, and it records each time it does that.

## Summary of New Capabilities

- Layer-freshness row, with bounded rebuild requests and one notice per stale episode.
- Hold-health row, which clears orphan fold holds and markers loudly, owner-only and corroborated.
- Eligible-without-fold row, observation only.

## Evidence

- Unit: `tests/unit/ContextBudgetSentinel-rows.test.ts`, `tests/unit/migrate-context-budget-sentinel-row.test.ts`.
- Integration: `tests/integration/context-budget-sentinel-rows.test.ts` (real TopicMemory, capture loop, layer store, hold store and routes).
- E2E: `tests/e2e/context-budget-sentinel-rows-alive.test.ts` (production boot path, real governor, WIRED source checks).

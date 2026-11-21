<!-- bump: patch -->
## What Changed

The context budget's watcher (ContextBudgetSentinel) could only watch, never act, on an agent whose session pool is live. Every conversation counted as "observed only", because ownership read as unknown. It now uses the same ownership rule as the fold coordinator: a conversation is owned by the machine its active ownership record names. On that machine the watcher can request a stale summary's rebuild, clear an orphaned hold, and reconcile a stuck fold. Other machines still only watch.

## What to Tell Your User

Nothing to do. On agents that run across several machines, the context budget's watcher now actually keeps conversation summaries fresh, instead of only reporting on them.

## Summary of New Capabilities

- None user-visible beyond the watcher acting where it owns a conversation (`GET /context-budget/sentinel` → `observedOnly` drops to the topics another machine owns).

## Evidence

- Unit: `fold-pool-ownership` (+1, `poolLiveOwner` on every side).
- E2E: the wiring check that the sentinel's `ownsTopic` uses `poolLiveOwner`, and that the coordinator and sentinel share the ownership closures. The sentinel suites (`ContextBudgetSentinel`, `-rows`; e2e sentinel lifecycle and rows) pass. Lint 54/54.

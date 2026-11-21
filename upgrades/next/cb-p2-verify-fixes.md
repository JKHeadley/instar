<!-- bump: patch -->
## What Changed

The context budget's practice folds are now listed in the project's feature ladder, LLM component registry and reviewed hook wiring. The summary layers' first soak is three days rather than seven.

## What to Tell Your User

Nothing to do. This is bookkeeping that lets the practice-run feature pass the project's checks and be tracked on the maturation board.

## Summary of New Capabilities

- The Maturation Board shows a row for practice folds, with a bar of 40 graded runs.

## Evidence

- Unit: `feature-ladders-coverage`, `llm-attribution-ratchet`, `native-hook-events-consumers`; a full local unit run found the failures these fix.

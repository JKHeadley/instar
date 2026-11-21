<!-- bump: patch -->
## What Changed

Three corrections to the context budget's practice folds, which remain off by default. A quiz that could not cover every required item no longer counts as a graded run. An item the restore bundle carried in its safe form is no longer marked missing. The handoff request no longer asks a session for a transcript id it cannot know. The design's Phase 1 freshness window is now three days instead of a week.

## What to Tell Your User

Nothing to do. The practice runs that test conversation shrinking now score more accurately, and the first check takes three days instead of a week.

## Summary of New Capabilities

- None. The shadow-fold record gains the skip reason `probe-floor-unmet`.

## Evidence

- Unit: new cases in `fold-shadow-runner`, `fold-grade` and `fold-handoff`; all fold suites and both ratchets pass (191 tests).

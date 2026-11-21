<!-- bump: patch -->
## What Changed

The context budget's running summary of a conversation no longer picks up the practice-fold handoff note. The layer ticker now skips the transcript range a fold's internal turns occupy, the lock window recorded by the fold coordinator. That way a conversation's "current work" never reads "writing a handoff note".

## What to Tell Your User

Nothing to do. The conversation summaries stay about the real work, even while practice folds run in the background.

## Summary of New Capabilities

- None user-visible. Internal: `dropLockWindows` and the ticker's `lockWindows` input.

## Evidence

- Unit: `tests/unit/context-layer-lock-window.test.ts` (7) covers a closed window, a window closed early by time, a start scrolled out of the tail, an open window, no or unmatched windows, several windows, and a real ticker pass that feeds the work around a handoff but never the handoff itself.
- E2E: `context-budget-fold-shadow-alive` wiring check that server.ts passes the durable lock windows to the ticker.
- Lint 54/54.

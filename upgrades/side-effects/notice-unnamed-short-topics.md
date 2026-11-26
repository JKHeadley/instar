# Side-Effects Review — Unnamed Short Topic Notices

Date2026-11-22. Author echo. Tier1, SMALL, reversible display repair; one review pass, one commit attempt planned.

## Summary
plainReferenceText replaces a one- or two-digit topic reference only when followed by an explicit unresolved-name marker. This isolates the saved notice repair after3579 merged; count changes remain in3658.

## Decision-point inventory
No authority surface. Existing Notifications rendering consumes this helper; only presentation changes.

## 1. Over-block
No block/allow surface. Ordinary numbered prose is preserved because it lacks a missing-name marker.

## 2. Under-block
No block/allow surface. Unrelated identifiers and unknown marker formats remain subject to existing display rules; this change does not invent names.

## 3. Level-of-abstraction fit
Shared display helper already owns reference wording; no per-page duplicate renderer is introduced.

## 4. Signal vs authority compliance
Reference docs/signal-vs-authority.md. No message filtering or action gate; notices are retained with the same controls.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. The explicit missing-name marker is a display format, not a judgment about a message or authority.

## 5. Interactions
Longer topic ids retain their verified-name lookup. Source text, card actions, hrefs and retry behavior are unchanged.

## 6. External surfaces
Dashboard notices say a conversation rather than an unrecognized short topic number.

## 6b. Operator-surface quality
Plain readable fallback, no fabricated name and no technical target added.

## 7. Multi-machine posture
Shared dashboard assets ship on every machine. Source notification pooling and reference identity remain unchanged; no machine-local state.

## 8. Rollback cost
Revert and normal release; no migration or source-data repair.

## Validation
22 targeted console-live-check-fixes tests passed. Independent reviewer read the exact boundary and concurred. Complete verification remains in the shared queue; this is not a full-green or release claim.

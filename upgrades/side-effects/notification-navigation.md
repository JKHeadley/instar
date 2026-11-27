# Side-Effects Review — Notification Navigation

**Version / slug:** notification-navigation
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** SMALL independent review

## Summary of the change
Tier1 SMALL, a reversible lifecycle repair. One runtime file and its rendered-page tests, plus overview, side-effects and release note. A delayed Mark read completion could replace the current page through an unconditional refresh. Refresh now verifies that its rendered root is still connected and belongs to main. One review and one red/green implementation cycle planned; no new authority.

## Decision-point inventory
Only the decision to repaint an existing screen changes. Identity is structural: the original root must still be attached to the same main. Existing authenticated owner-scoped PATCH, preference writes and action permissions pass through unchanged.

## 1. Over-block
No server write or legitimate permission is blocked. An active view still refreshes. Detached or replaced views cannot repaint; these are obsolete displays, not rejected user actions.

## 2. Under-block
No validation is added. Existing server routes remain responsible for authority. Initial feed reads only append to their own root and cannot replace another page after navigation.

## 3. Level-of-abstraction fit
The renderer owns its view lifecycle and knows the root it created. No server, router or scheduler change is needed. A fixed delay or global route string would be less precise than actual root ownership.

## 4. Signal vs authority compliance
Complies with docs/signal-vs-authority.md. No action gate or brittle blocking detector is introduced. This is a structural display ownership condition, never authority to deny or cancel an operation.

## 5. Interactions
Normal active refresh remains unchanged. The pending notification-preview change touches the same renderer and test file, but does not modify this refresh closure; retain both changes when integrated. Changing filter creates a new root, preventing the earlier save from resetting the newer view or clearing its cursor. Request completion and errors do not acquire a new retry. No new polling, cleanup or event listeners.

## 6. External surfaces
Only the web page response to a delayed save changes. Requests, response formats and durable state are unchanged. The existing Mark read control remains phone-completable; there is no new operator action. Failed saves report to the original view's existing status element.

## 6b. Operator-surface quality
1. The existing Mark read action remains visible on every notice. No action moves or collapses.
2. No new visible identifiers, internals or technical language.
3. No destructive control is added or promoted.
4. Existing labels and44pixel target remain unchanged. Four real Chrome fixtures at390/1280pixels in both themes verify that the current page remains Accounts after the delayed save, with no additional refresh requests and no overflow. Private screenshots/results are under .instar/dashboard-makeover/notification-navigation in the agent home. No native app claim.

## 7. Multi-machine posture (Cross-Machine Coherence)
Replicated: dashboard assets follow normal package installation. The existing pooled feed and owner-machine PATCH routing are unchanged. Slow peer responses are exactly why view ownership matters. No new notices, durable state, URLs, status, health, capabilities or channels answers. No state can strand on topic transfer.

## 8. Rollback cost
Revert the code and release a patch. No state migration, permissions cleanup or agent repair. Existing read acknowledgements remain valid.

## Conclusion
A narrow lifecycle fix preserves navigation without altering saved intent. 159focused checks,3integration cases, the production build and four browser cases passed before commit; one existing production notification-preferences lifecycle test also passed. Complete shared verification and released live checks remain pending.

## Second-pass review
Reviewer review_plan_approval concurred: structural root ownership preserves active-view refresh and server writes; all three stale-view race cases are covered. No runtime concerns raised.

## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect — not applicable. No self-triggered controller added or modified.

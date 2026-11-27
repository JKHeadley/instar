# Side-Effects Review — Ideas Decision Dialog Lifecycle

## Summary
Tier 1 SMALL. Two runtime files, rendered DOM tests, overview and release note. Optional source ownership check prevents a late Ideas PIN prompt from appearing after navigation, and prevents an old saved-decision timer from refreshing a newer view. Built in a fresh managed checkout at canonical ec9401e5b, version1.3.1989. Normal npm ci activated missing hooks.

## Decision Points
Only whether to display an obsolete dialog or repaint an obsolete view. The actual server plan, PIN, nonce and commit authority remain unchanged. No brittle semantic action gate is introduced; source-node connectedness is a structural UI lifetime check. Complies with docs/signal-vs-authority.md.

## Over-block
A confirmation source removed by ordinary page navigation or a newer render no longer opens a dialog. That is deliberate UI cancellation before proof, not denial of a saved action. Other askPin callers omit the optional callback and behave as before. Existing session-token fast path checks current ownership before returning proof.

## Under-block
No new permission or input validation. Already submitted commits complete normally. A current Ideas card can still request confirmation. This change does not claim to repair all unrelated confirmation callers.

## Layer Fit
The Ideas card owns its status node. The shared PIN helper owns the awaited unlock-check and therefore must re-check the supplied callback immediately before building a dialog. Putting a single check in Ideas before calling the helper would miss navigation during unlock-check.

## 4b. Judgment-point Check
No new static heuristic at a competing-signals decision point. The source node is either connected or detached, an enumerable DOM lifecycle invariant, never a semantic permission decision.

## Interactions
Retains the same renderer and setKids flow, preserving saved expansion, focus and scroll handling. Pending Ideas grouping change can retain this independent decide-function change. No read polling or timer is added; the existing 600ms timer now checks the originating card. No old decision is retried or cancelled after submission. No status mutation of detached nodes reaches the new page.

## External Surfaces
The only visible change is absence of a stale prompt and stale repaint. No route, payload, setting, credential, durable store, owner choice or generated URL changes. Users see their current page without an unrelated old dialog.

## 6b. Operator-Surface Quality
1. Existing primary idea actions remain visible; no collapse or extra step is introduced.
2. No raw identifiers or internals are added to visible copy.
3. Existing destructive-action styling is unchanged.
4. Normal Chrome fixed390/1280 frame previews in both themes show contained dialogs without horizontal overflow and48pxContinue buttons. The existing close button measures34x30 and is tracked separately by design-standards in .instar/design-feedback-private/design-findings-queue.json; this patch changes no hit areas. Measurements waited350msfor sheet animation. The fixture uses sample data, not a live account.

## Multi-Machine Posture
Replicated as normal packaged dashboard assets. Existing pooled reads and server plan/commit routing are unchanged. Late peer replies are one reason the boundary matters. No new notification or channel to deduplicate and no state can strand on topic transfer.

## Rollback
Revert code and publish a patch; no state repair or migration. Already committed choices remain valid.

## Verification
Original real renderer/real PIN helper reproduces stale prompt after full main replacement. The final source passes113focused unit cases (25new lifetime cases,6existing Ideas model cases,82shared UI regression cases),17HTTP integration cases and4production lifecycle cases. The25new DOM cases use synthetic HTTP: delayed plan/unlock across three obsolete views and accepted/refused address checks, current submit/cancel/errors, eight delayed-commit/refresh boundaries, and compatibility without a callback. Four normalChrome390/1280 light/dark preview cases passed with sample data and350msanimation wait; source patch matches the preview. The production build passed. Normal commit gates and complete shared verification remain pending. Do not claim this is released or live.

## Class Closure
No agent-authored-artifact or self-triggered-controller defect. This closes both async pre-dialog boundaries for the Ideas confirmation source and the existing post-commit refresh boundary.

## Independent Review
review_ideas_dialog concurred after the actual dialog selector and eight deferred-commit refresh cases were added. Reviewer concurred again with the final source diff and test cleanup; no runtime concerns found.

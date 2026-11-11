# Side-effects: Conversations release branch (main merged in, 2026-11-09)

## Summary

`merge/conversations-main-1109` is `feat/conversations-ui-1105` with current main merged in (675172ea2c, parents 9884853c45 and origin/main 46e6980ba3), plus later merges of the day's fixes. Each fix has its own side-effects note. This note covers the main merge itself, which had 16 conflicting files, and the release note rewrite (upgrades/next/conversation-graph-core-increment-a.md).

Conflict resolution kept both sides' behaviour:
- `mobilePairingRoutes.ts`: main's rule list shape (team tiers, browser route list, self-check) stays, with the branch's 8 owner-only conversation-graph rules added at owner tier and closed to browser devices. For non-owners the branch's `hierarchy-owner-only` refusal fires on graph paths before main's team checks.
- `mobileOwnerDeviceAdmission.ts`: the branch's shared owner check, with main's browser-aware key read and a new `browser-off` refusal when the browser switch is off.
- `CoherenceJournal.ts` and its test: kind lists, types, sequence numbers and per-kind tables are the union (main's `failure-callout-chunk`, `conversation-read-marker`, `email-outbox-record`; the branch's `conversation-graph-event`).
- `server.ts`, `AgentServer.ts`, `routes.ts`, `mobileConversationRoutes.ts`, `selfActionRegistry.ts`, `SlackAdapter.ts`, `console.js`, `GitLeaseStore.ts`, `LocalLeaseStore.ts`, `stageBCertifiedSet.ts`, the notification baseline and the slack wiring test: additions from both sides kept; where one side rewrote a function, the other side's addition was ported into the new shape.
- Two compile errors git merged silently were fixed: a duplicate `fs` import in `AppConversationService.ts`, and main's new app-ingest path calling `onAccepted` with one argument where the branch's signature needs three.

## 1. Over-block
Graph mobile routes are closed to browser devices (main's default for new owner routes). The dashboard does not call them today. A new admission refusal reason `browser-off` exists; a consumer that switches over every reason would need to add it.

## 2. Under-block
No issue identified. Main's team, browser and owner checks run unchanged around the branch's graph rules.

## 3. Level-of-abstraction fit
Resolution followed each side's structure rather than picking a side.

## 4. Signal vs authority compliance
No authority added. Existing checks from both sides kept.

## 5. Interactions
Main's app-ingest path calls `onAccepted` without running the graph `beforeReceipt`; app commands never carry graph delegation payloads, so this is harmless.

## 6. External surfaces
None beyond each side's own changes.

## 7. Multi-machine posture
Unchanged from each side.

## 8. Rollback cost
Revert the merge commit. No state or format change of its own.

## Class-Closure Declaration
Defect class: n/a. Closure: n/a. A merge, not a new mechanism.

## Evidence
- `tsc --noEmit` clean after the merge; 31 focused test files passed (1257 tests) on the Studio at 675172ea2c.
- Full suites on the M5 at 969c81f2b0 (the head this note ships with, minus the release note): integration 6,883 passed, 0 failed. Unit: 48 failures, all in MacDesktopHostCapture, MacDesktopHostIdentity and desktop-displays, which fail the same way on origin/main on the M5 (SourceTreeGuard refusal in that checkout). E2E: see the pull request.
- Real Studio + M5 runs on this branch: chat and media proof all passed at 988bdd7793; 200-effort removal clean at 2ef62f2048.

## Second-pass review
Not run as a separate review of the merge. Each conflict resolution was checked against both sides' history by the resolving session, and the merged code was then exercised by the full integration suite and two real two-machine runs listed above.

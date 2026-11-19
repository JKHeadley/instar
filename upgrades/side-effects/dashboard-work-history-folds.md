# Side-Effects Review — Finished work starts folded

**Date:** 2026-11-17
**Author:** Echo
**Second-pass reviewer:** review_work_folds (independent Codex review: concurred)

## Summary of the change
Tier 1, a narrow reversible presentation fix. The Work board's Done and Archived lanes start folded with their totals visible. Done opens for explicit paging. Cards and paging remain together inside the fold. Active work and its action controls retain their presentation. Two runtime/test files, approximately 65 added lines; one review round, no commit attempts yet. Driven by approved docs/specs/work-front-doors.md section 2.1 (Done folded).

## Decision-point inventory
Only presentation: initial expansion of the two enumerated history lanes. No authorization, lifecycle or routing decision changes.

## 1. Over-block
No block/allow surface. The user can expand either history lane; its cards keep their existing actions.

## 2. Under-block
No block/allow surface. This does not alter the server's permissions or card validation.

## 3. Level-of-abstraction fit
The browser renderer owns folding. The shared setKids place-restoration code already preserves a user's chosen fold state; no duplicate state store is introduced.

## 4. Signal vs authority compliance
No block/allow surface. docs/signal-vs-authority.md applies unchanged; a presentation default does not grant or deny an action.

## 4b. Judgment-point check
No new heuristic at a competing-signals decision point. Done and Archived are enumerated existing lanes.

## 5. Interactions
The toggle follows existing console button and aria-expanded conventions. Paging is inside the fold, and an explicit later page opens Done. Shared refresh restoration preserves user changes. Direct card links still open a loaded card independently of its folded lane. No new asynchronous work or mutation is introduced.

## 6. External surfaces
The web console and clients using it show two compact history headings. Native client code and API responses are unchanged. No new capability or scaffold-awareness entry is needed for this correction to the approved existing presentation.

## 7. Multi-machine posture
Replicated through the shipped static assets on each installation; fold choice is browser-local presentation by design. No durable agent state or cross-machine message is added.

## 8. Rollback cost
Revert this commit and deliver the old static asset; no state repair or migration.

## Verification
The added DOM tests first failed because no fold control existed. 45 targeted tests passed, including a direct-link regression. Independent review found no blocking issues and recommended that direct-link case. Chromium at 1280 and 390 pixels verified visible active cards, folded history, click and keyboard expansion, refresh preservation and no horizontal overflow. After merging main at 00e04e7c8, all 854 targeted and guard tests across 33 files passed, including every unit ratchet. The queued local full suite was cancelled at the merge coordinator’s request to preserve the shared verification slot. Complete unit/integration/e2e validation remains pending the merge line; no full-suite pass is claimed.

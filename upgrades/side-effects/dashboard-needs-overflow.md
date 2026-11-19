# Side-Effects Review — Needs-you overflow

**Date:** 2026-11-17
**Author:** Echo
**Independent reviewer:** review_work_folds, concurred with no blockers.
**Tier:** 1, small reversible display correction under work-front-doors decision 2.

## Decision-point inventory
Presentation of the server's existing truncation flag and total count. No permission, lifecycle, routing or authoritative state decision.

## Over-block and under-block
No block/allow surface. Existing actions and the server response ceiling remain unchanged. Omitted items are named as missing; this does not claim new access to them.

## Level of abstraction
The browser knows both the total and received row count. It should describe their difference and expand only what is present. No second truth store or new pagination protocol.

## Signal versus authority and judgment
No block/allow surface; docs/signal-vs-authority.md applies unchanged. Comparing counts is presentation arithmetic, not a heuristic deciding intent or authority.

## Interactions and external surfaces
Small complete lists keep their wording and behavior. A failed-source warning remains visible alongside overflow. Count completeness still describes source coverage; truncation describes row availability. Web console only; API and native apps unchanged. No new capability, migration or scaffold-awareness requirement.

## Multi-machine posture
The answering machine supplies the counts and truncation flag. No persisted state or replication change.

## Rollback
Revert the static asset change. No data repair.

## Verification
Two added regressions failed before the fix (20 existing cases passed); all 49 front-door and needs-read tests now pass. Independent review concurred. Chromium at 390 and 1280 pixels verified truthful button text, keyboard expansion to 100 rows, return to three rows, persistent omitted-row and failed-source notices, and no horizontal overflow. Phone screenshot visually checked. All 1111 targeted and guard tests across 37 files passed in batches of at most five. Release-note headings failed validation twice; the complete required section structure was corrected and the failed batch rerun green. Complete unit/integration/e2e validation belongs to Local Verify before merge under maintainer authorization f4adb757-d0c9-4782-af84-6fbde72ef9e9.

## Remaining limitation
The server caps each answer at 100 rows and has no pagination. This change prevents the console from implying that expansion shows omitted items; it does not solve access to every omitted item from this strip.

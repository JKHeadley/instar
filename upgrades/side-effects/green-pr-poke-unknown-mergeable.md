# Side-effects review: a verified PR with UNKNOWN mergeability is read directly

## Change
`src/monitoring/GreenPrAutoMerger.ts` (`gather`): when a candidate is skipped as `not-mergeable` because the PR list reported `mergeable: UNKNOWN`, and its head is verified (a passing local-verify record under the local floor; any candidate under the actions floor), the watcher logs `waiting: mergeability-unknown` and reads that PR once with the existing `refetchPr` (a direct single-PR read), whose field list (`REFETCH_PR_JSON_FIELDS`, `greenPrAutomergeWiring.ts`) now also requests `mergeable`, pinned by the wiring test. Under the actions floor the nudge also requires green checks (`statusRollup === 'SUCCESS'`). GitHub computes mergeability on a direct read, so the next tick lists it as MERGEABLE. A real `CONFLICTING` PR is not read.

## Evidence
On the Studio (2026-11-02) after #2602, #2609 and #2606 merged, #2611 (verified at 22:00) was absent from the watcher's candidates on every pass and a manual pass answered `no-candidate`; a direct `gh pr view` returned MERGEABLE, and the very next pass merged it (22:30). Earlier the same day #2602, #2605, #2609 and #2611 all read MERGEABLE only after being viewed directly.

Live check 2026-11-02 22:44 UTC: PR #2457 listed UNKNOWN; after one direct read the list returned MERGEABLE.

## 1. Over-block
None.

## 2. Under-block
Merging still waits one tick after the nudge (the list is re-read next tick).

## 3. Level-of-abstraction fit
`gather` is where list fields decide candidacy; the read reuses the existing dependency.

## 4. Signal vs authority
No change to what may merge; safe-merge stays the authority.

## 5. Interactions
At most one extra GitHub read per verified-but-UNKNOWN PR per tick (a handful). The read's errors are swallowed (it is only a nudge). `act()` still refetches before any attempt.

## 6. External surfaces
Fewer stalled ready PRs; one new audit event class.

## 7. Multi-machine posture
Lease holder only, as before.

## 8. Rollback cost
Revert.

## Class closure
unbounded-self-action: n/a. One bounded read per verified PR per tick; no new loop or trigger.

## Second-pass review
**Reviewer:** independent Claude Opus 5.5 subagent (general-purpose), given the diff and the write-up, not the conclusion.

First pass raised: the production read did not request `mergeable`; no wiring pin; the actions-floor case nudged PRs with unfinished checks. All three fixed (field added and pinned, `statusRollup === 'SUCCESS'` required, a PENDING case in the unit test). Second look: "Concur with the review." `refetchPr` is a plain read-only `gh pr view`; `recordFor` uses the same lookup as the classifier; warm-up and dry-run ticks make the read harmlessly; awaiting in the loop keeps rate use small.

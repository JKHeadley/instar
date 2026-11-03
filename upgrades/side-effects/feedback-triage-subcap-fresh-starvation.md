# Side Effects Review — fresh triage after retry cap

**Version / slug:** `feedback-triage-subcap-fresh-starvation`
**Date:** 2026-11-02
**Author:** Echo
**Second-pass reviewer:** independent read-only review concurred after direct and verified-account boundary checks

## Summary of the change

Tier 2; one production file (9 added, 1 removed line) and one test file (33 added lines), plus release and review records. This used the existing approved spec with no new spec review round, one independent source review, and one successful commit gate attempt after installing the worktree hook. `FeedbackTriageService` now skips a retry batch when the separate 50-call retriage allowance is exhausted, then continues to eligible first-time batches. The change preserves the main daily call limit, model decision authority, retry queue and existing report floors. A live Echo snapshot showed three fresh reports waiting behind an older truncated retry, with 53/150 total calls used and 50/50 retry calls used. A focused regression failed before the change and passed afterward.

## Decision-point inventory

- `FeedbackTriageService.tick` batch admission — modified: an exhausted retry-only allowance skips that batch instead of ending the tick, so first-time items can use their independent remaining budget.
- Model disposition and deterministic floors — passed through unchanged.

## 1. Over-block

An exhausted retry batch remains queued until its allowance resets. That is the existing intended cap. A fresh item is still refused when the overall daily call limit, account admission, or time budget blocks its call.

## 2. Under-block

The check reads the existing durable retry counter. The actual reservation still enforces both limits transactionally, including for verified-account admission. If a competing reservation exhausts the overall allowance after the skip check, the existing reservation fails closed. The fix does not address other triage stalls, such as unavailable model accounts.

## 3. Level-of-abstraction fit

This is a scheduling invariant at the batch admission layer, before either direct or verified-account model calls. The model still decides each report's disposition.

## 4. Signal vs authority compliance

The retry counter has authority only over retry-call admission, as specified. It no longer blocks unrelated first-time calls. No brittle content detector decides a report disposition.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. This is the existing numerical subcap applied to its own call class.

## 5. Interactions

- **Shadowing:** the skip occurs before budget checks for an ineligible retry batch; fresh batches still go through deadline, aggregate cap, account admission and model review.
- **Double-fire:** retry reservations remain in the existing store; the skip only avoids futile reservation attempts.
- **Races:** the store's transactional reservation remains authoritative. A stale skip read can only lead to a later failed reservation, not a cap bypass.
- **Recovery:** queued retry rows remain queued and can run after the UTC-day reset. Fresh rows advance when their own calls are allowed.

## 6. Rollout and observability

No new config, schema, template or migration. The triage summary still reports queued/untriaged counts, daily call use and `call-cap-reached` for a partially capped tick. The first live check after deployment should show fresh rows decreasing while the retry row remains queued until reset.

## 6b. Operator-surface quality

No dashboard or operator form changes. The existing summary fields are sufficient to verify the change.

## 7. Multi-machine posture

The same drain database contains the counters and the transactional call reservations. The current owner lease and epoch fencing remain unchanged. Only the owner runs the tick.

## 8. Rollback cost

A source revert restores the prior admission order. No data migration or row rewrite is required; queued retry rows persist across either version.

## Verification

The focused regression failed on the old source with `decided=0`; after the change, all 52 triage service unit tests pass, including the verified-account path. Build and lint pass. The independent reviewer concurred after checking the 49-to-50 and 50-of-50 boundaries, shared counter, and both reservation paths. Existing integration and E2E lifecycle tests, exact-head full suite, and CI remain to be recorded before release.

The first GitHub Docs Coverage check failed at 54% class coverage against its 55% floor. I added accurate component responsibilities to the feedback factory documentation for `FeedbackManager`, `FeedbackAnomalyDetector`, and `TriageOrigin`. The local coverage check now passes at 55% class coverage. The remaining GitHub checks still need to run on the revised head.

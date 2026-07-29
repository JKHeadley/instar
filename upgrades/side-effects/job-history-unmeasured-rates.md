# Side-Effects Review — Job-history unmeasured rates

**Version / slug:** `job-history-unmeasured-rates`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`JobRunStats.successRate` and `avgDurationSeconds` are nullable when their sample
sets are empty. The category-report route averages only measured success rates
and returns null when every matching job is unmeasured.

## Decision-point inventory

- Metric evidence sufficiency — modified — empty completed-run or duration sets
  no longer become numeric rates.
- Scheduling, execution, and health classification — passed through unchanged.

## 1. Over-block

No action is blocked. Consumers must render nullable read-surface fields, but
all measured rates retain their existing numeric values.

## 2. Under-block

Runs with recorded zero duration remain excluded by the existing duration
contract, so an all-zero-duration sample is still unmeasured. This change does
not validate whether an individual recorded outcome was labeled correctly.

## 3. Level-of-abstraction fit

Per-job nullability belongs where run samples are aggregated. Category
nullability belongs at the route aggregation boundary, supported by a pure
helper in the job-history module so the exclusion rule is directly tested.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

These fields are read-only observability. Scheduler admission, job execution,
failure counters, and operator controls do not consume them as authority.

## 4b. Judgment-point check

No heuristic judgment is introduced. A percentage requires at least one
completed run, and an average duration requires at least one measured duration.

## 5. Interactions

- **Shadowing:** null replaces only the two empty-sample fallbacks.
- **Double-fire:** no events or notifications are emitted.
- **Races:** history read and write behavior is unchanged.
- **Feedback loops:** category reports remain observational.

## 6. External surfaces

Job-history and category-report JSON can now contain null for `successRate`,
`avgDurationSeconds`, and `avgSuccessRate`. Counts remain numeric. Existing
measured rates are byte-for-byte unchanged.

## 6b. Operator-surface quality

An unrun job no longer renders as zero-percent success, and an unmeasured job
cannot dilute a category average. Clients can distinguish absence from failure
using the null plus existing count fields.

## 7. Multi-machine posture

**Machine-local by design.** Each scheduler reports the history stored on its
host. The change does not alter pool merging, topic placement, or replication.

## 8. Rollback cost

Pure code rollback: restore the zero fallbacks and simple category average. No
stored history or agent state requires migration.

## Conclusion

Clear to ship as a small corrective PR. It changes only the truthfulness of
empty-sample read surfaces.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no action, lifecycle,
authority, sentinel, guard, or gate behavior changes.

## Evidence pointers

- `tests/unit/JobRunHistory.test.ts`
- `tests/e2e/job-run-history-lifecycle.test.ts`
- Fifty-three focused tests pass.
- Mutation proof: restoring the zero fallback fails the null assertion.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

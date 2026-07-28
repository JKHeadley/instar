# Side-Effects Review — Nine-feature rollout placement closure

**Version / slug:** `nine-feature-rollout-closure`
**Date:** `2026-07-21`
**Author:** `Instar-codey`
**Second-pass reviewer:** `throughput_second_pass (concurred)`

## Summary of the change

This change accounts for source PRs 1531–1539 in the existing rollout scanner,
InitiativeTracker, and D7 lifecycle ledger. Five independently controlled features
are active, three owner-controlled components are composed, and one documentation-only
source is excluded. Existing owner services provide bounded numeric projections; no
new rollout control or persistence authority is introduced.

## Decision-point inventory

- `featureRolloutScan` contract parsing — modified — classifies explicit rollout
  accounting metadata and rejects malformed contracts as invalid evidence.
- `FeatureRolloutReconciler` placement — modified — maps active controls to rungs while
  preserving null rungs for composed and excluded rows.
- `BlockerLifecycleService.evaluateMaturation` — modified — evaluates active and
  composed evidence through the existing D7 authority; excluded rows remain visible
  but ineligible.
- Pool-summary sanitizer — modified — rejects structurally dishonest peer summaries.

## 1. Over-block

Malformed or future-version peer accounting rows are rejected from the pool summary.
That is intentional boundary validation: accepting a row whose claimed disposition,
rung, counts, or descriptors disagree would corrupt the denominator. Local legacy rows
remain supported explicitly through `legacyEligible`.

## 2. Under-block

A structurally valid peer can still report inaccurate underlying owner measurements;
this change validates the contract envelope, not remote machine integrity. Freshness,
sample floors, and owner-local projection semantics keep missing or stale evidence from
becoming green, but Byzantine peers are outside this trusted-agent pool model.

## 3. Level-of-abstraction fit

The scanner owns declarative contract discovery, InitiativeTracker owns placement
accounting, existing feature services own operational truth, and D7 remains the sole
maturation evaluator. The implementation extends those existing layers instead of
adding a parallel registry, synthetic flag, or child-owned promotion authority.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The new projections are numeric observations. They do not promote, block, or mutate
their owner systems. D7 consumes them under persisted contracts and produces the
existing HOLD/READY/REGRESSED lifecycle decision. Pool validation is a hard structural
API invariant, which the principle explicitly permits at system boundaries.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals judgment point. Thresholds and
sample floors are explicit feature contracts; disposition/rung relations and peer
schema checks are enumerable invariants. Promotion remains outside this change.

## 5. Interactions

- **Shadowing:** contract errors become `invalid-contract` before metric evaluation;
  they cannot be misreported as ordinary missing evidence.
- **Double-fire:** projections are read-only snapshots and do not trigger owner actions.
- **Races:** each snapshot tolerates concurrent owner updates; it records a bounded
  point-in-time value and D7 applies its existing evaluation transaction.
- **Feedback loops:** maturation output does not write into source metrics or promote a
  rollout, so no control loop is introduced.
- **Degradation visibility:** a throwing owner projection or failed bounded recovery-log
  read reports through `DegradationReporter`; the observation remains absent/HOLD.

## 6. External surfaces

The blocker lifecycle local and pool summary responses gain accounting rows, metric
descriptors, exact counts, nullable rungs, and promotion-authority labels. Existing
legacy response semantics remain represented. The D7 SQLite schema migrates its source
CHECK and nullable-rung constraint transactionally while preserving rows and indexes.
There are no new operator actions, URLs, notices, or external-service writes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Proxied-on-read:** source observations are machine-local truths, while
`/blocker-lifecycle/summary?scope=pool` merges and strictly validates peer summaries.
The response preserves per-origin accounting rather than pretending local counters are
replicated. This emits no user-facing notices, creates no generated URLs, and strands
no topic-owned state. The existing D7 ledger remains machine-local evidence history;
pool reads are the cross-machine answer surface.

## 8. Rollback cost

Revert and ship a patch. The ledger migrations are additive/compatibility-preserving;
older code ignores accounting stored in initiative JSON and can read the recreated D7
tables. No external state repair or user notification is required.

## Conclusion

The change is clear to ship. Review tightened classified-claim causality, hostile-peer
invariants, mixed legacy/accounted denominators, nullable-rung migrations, and explicit
promotion authority. Focused typecheck and 38 rollout/migration tests pass.

## Second-pass review

**Reviewer:** `throughput_second_pass`
**Independent read of the artifact: concur**

The independent implementation review completed three passes and concurred after the
claim, pool-integrity, denominator, and migration findings were repaired and tested.

## Evidence pointers

- `tests/unit/featureRolloutScan.test.ts`
- `tests/unit/feature-rollout-reconciler.test.ts`
- `tests/unit/BlockerLifecycleMaturation.test.ts`
- `tests/integration/blocker-throughput-pool-routes.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect and no self-triggered controller — not applicable.

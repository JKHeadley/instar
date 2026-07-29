# Side-Effects Review — SDK-credit zero total

**Version / slug:** `sdk-credit-zero-total`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`CostStateTracker.snapshot()` maps invalid total-credit denominators to its
existing `agentSdkCredit: null` state.

## Decision-point inventory

- SDK-credit snapshot validation — modified.
- Material-shift comparison — unchanged; it already handles known/unknown
  transitions.
- Routing policy — unchanged.

## 1. Over-block

Positive finite totals preserve prior behavior, including a zero remaining
balance.

## 2. Under-block

Zero, negative, and non-finite totals cannot produce a known consumed fraction.
Non-finite remaining values are rejected at the same boundary.

## 3. Level-of-abstraction fit

The tracker is the first shared layer that constructs the cached cost-state
shape. The HTTP comparison route already uses the same denominator rule.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — the tracker supplies a signal to cache invalidation.

Unknown state may invalidate a cached choice through the existing
known-to-unknown reason; it does not select a provider by itself.

## 4b. Judgment-point check

No heuristic threshold change. Denominator validity is deterministic.

## 5. Interactions

- **Shadowing:** invalid totals use the established null state.
- **Double-fire:** one material-shift reason at most.
- **Races:** snapshot timing and TTL behavior are unchanged.
- **Feedback loops:** valid provider snapshots are byte-for-byte equivalent.

## 6. External surfaces

Consumers see `agentSdkCredit: null` instead of a contradictory zero-total
object.

## 6b. Operator-surface quality

Zero total can no longer look like zero consumption.

## 7. Multi-machine posture

Local provider state only; the same validation applies wherever the tracker is
constructed.

## 8. Rollback cost

Pure validation rollback. No persistence.

## Conclusion

Clear to ship as a bounded cost-state consistency correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; no provider-selection
threshold or authority changes.

## Evidence pointers

- `tests/unit/providers/costAwareRouting.test.ts`
- `tests/unit/providers/uxConfirm/TriggerGate.test.ts`
- `tests/unit/providers/uxConfirm/FrameworkModelRouter.test.ts`
- Mutation proof: restoring the zero-total object fails the boundary test.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

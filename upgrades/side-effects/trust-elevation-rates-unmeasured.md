# Side-Effects Review — Trust-elevation rates unmeasured state

**Version / slug:** `trust-elevation-rates-unmeasured`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`TrustElevationTracker.getAcceptanceStats()` now returns null rates when no
non-deferred proposal has been decided. Elevation checks explicitly reject a
null recent rate and retain their existing minimum-count requirements.

## Decision-point inventory

- Acceptance-stat evidence sufficiency — modified — a rate requires a decided
  proposal.
- Evolution-governance elevation — preserved — minimum count plus measured
  threshold remains required.
- Profile elevation — preserved — either measured count-gated acceptance or
  independent operation-trust evidence remains required.

## 1. Over-block

No previously eligible measured history is blocked. The new null guard is
reachable only when the decision denominator is empty, which was already below
the minimum count.

## 2. Under-block

An empty history still produces no elevation opportunity. Tests pin both
governance and profile paths in the same state as the nullable rates.

## 3. Level-of-abstraction fit

`TrustElevationTracker` owns the decision history, statistics, and count-gated
consumers, so it can change the contract without leaving an unsafe downstream
interpretation.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — the rates inform an authority suggestion, but only after a
  deterministic minimum-count gate and a measured threshold.

This change makes the signal less authoritative in the absence state. It does
not grant or broaden any operation.

## 4b. Judgment-point check

No heuristic changes. Existing thresholds and decision floors are unchanged.

## 5. Interactions

- **Shadowing:** null replaces only empty-history zeros.
- **Double-fire:** no opportunities are created from the empty state.
- **Races:** state persistence and event recording are unchanged.
- **Feedback loops:** measured acceptance still follows the existing evaluator.

## 6. External surfaces

The acceptance API and status payload can now return null overall and recent
rates when `totalDecided` is zero. Measured values retain the same scale.

## 6b. Operator-surface quality

`totalDecided: 0` remains beside both null rates, so their reason is explicit.

## 7. Multi-machine posture

Unchanged. State ownership and synchronization are not modified.

## 8. Rollback cost

Pure code rollback. No stored events or schemas change.

## Conclusion

Clear to ship as a bounded observability correction with authority preservation
proved in the same regression.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; the change reduces the
authority signal in an already count-blocked state and adds an explicit refusal.

## Evidence pointers

- `tests/unit/TrustElevationTracker.test.ts`
- Seventy-four focused unit, integration, and end-to-end tests pass.
- Mutation proof: restoring the zero fallback produces a direct failure.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

# Side-Effects Review — The fold benefit estimator and Cap 1 (context budget Phase 2 slice P2-5)

**Version / slug:** `cb-p2-benefit`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** not required (pure arithmetic with no decision authority: it blocks, kills, gates and spawns nothing)
**Spec:** `docs/specs/context-budget-layered-summaries.md` (v9, converged, approved) §7.2, §17 row "Cap 1 turns-to-wall"

## Summary of the change

`src/monitoring/foldBenefit.ts` is pure functions with no call site yet. The shadow runner (P2-4) reads them before it asks a session for a handoff.

- **`estimateFoldBenefit`**: break-even turns = cost ÷ per-turn saving, in the existing §11 cost weights (`COST_WEIGHTS`).
  - **Cost:** the handoff turn (a context re-read at the cache-read rate when the engine accounts a warm cache, else uncached, plus output), send-backs, the packet's cache write, and the fixed fold calls (passed in, measured).
  - **Saving:** (live − packet) × cache-read rate.
  - **Expected remaining turns:** the trailing turn rate × a 1-hour horizon, plus 4 turns per open thread in H1. Both are named defaults, calibrated by Phase 2.
  - **Verdict:** `worthAsking` when expected ≥ break-even × 1.5. `belowFloor` when expected is below break-even, or when the fold saves nothing.
  - **Cache-blind engines:** the saving at cache-read (a lower bound) and every cost term uncached (an upper bound).
  - **`unknown`:** only for poller lag or a non-finite input.
- **`capOne`**: turns-to-wall against the effective auto-compact window at the recent growth rate. It is critical when that falls to the headroom for one handoff turn plus one packet write. If any input is unknown, the result is `unknown`, which means no checkpoint request.

**Files.** New: `foldBenefit.ts`, `tests/unit/fold-benefit.test.ts` (9). Size: Tier 2 (spec-driven), about 130 LOC. One test fix: my margin test drove the turn rate negative, which correctly counts as zero.

## Decision-point inventory

None. The output feeds the runner's ask decision (§7.2 "the estimator is an input, named as such").

## 1. Over-block
None. This blocks nothing.

## 2. Under-block
The remaining-turns heuristic can over- or under-estimate. The spec makes the estimator an input whose estimated and realised break-even are both recorded (§11), so Phase 2 calibrates it. The margin and the cache-blind conservatism keep a bad estimate from over-selling a fold.

## 3. Level-of-abstraction fit
It reuses the §11 `COST_WEIGHTS` from `contextBudgetMetrics.ts`, so the estimator and the measurement price tokens identically.

## 4. Signal vs authority compliance
Signal only.

## 5. Interactions
None at runtime yet.

## 6. External surfaces
None.

## 7. Multi-machine posture
Machine-local by design. It is computed on the topic's owner from that machine's ledger.

## 8. Rollback cost
A revert.

## Testing tiers
Unit tests cover both sides of the margin and the floor, warm against cold, cache-blind pricing, unknown, and the Cap 1 boundary. This is pure arithmetic with no wiring, so the integration and alive tests come with the runner (P2-4), which reads it.

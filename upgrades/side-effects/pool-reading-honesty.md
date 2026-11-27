# Side-Effects Review — two pool readings that said more than they knew

**Version / slug:** `pool-reading-honesty`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** not required

## Summary of the change

Wording only, found in the first live rebalancing proof. The readiness channels line names the platform it cannot serve. `POST /pool/transfer` no longer says a seat did not move when the owner only failed to answer in time. `src/core/poolReadiness.ts`, new `src/core/poolTransferReason.ts`, `src/server/routes.ts`.

## Decision-point inventory

- `seatMoveReason` — modify — text only; `seatMoved` is unchanged.
- readiness channels reason — modify — text only; `state` is unchanged.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

Right layer: the code that composes each reason.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. Both are signals. Nothing reads the text to decide.

## 5. Interactions

No test or caller matches the old strings outside the helper's own test. `seatMoved` stays false on timeout, so the live-test harness reads it as before.

## 6. External surfaces

Two reason strings in API responses change.

## 7. Multi-machine posture

Machine-local text, no state.

## 8. Rollback cost

Revert the release. No state.

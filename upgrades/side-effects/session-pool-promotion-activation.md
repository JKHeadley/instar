# Side-Effects Review — Session-pool promotion activation

**Version / slug:** `session-pool-promotion-activation`
**Date:** `2026-07-23`
**Author:** Instar Agent (instar-codey)

## Summary

This change activates the already-merged session-pool rollout driver behind an
explicit, default-off selector. Auto-climb schedules one driver tick per
cadence; operator mode exposes only the authenticated one-step route. Both
paths reuse the signed E2E result store and StageAdvancer.

## Decision-point inventory

- The config resolver accepts only `off`, `operator`, and `auto-climb`; unknown
  values fail closed to off.
- The activation controller invokes the existing driver only in a selected
  live model.
- The existing driver and StageAdvancer retain green-evidence, commit-binding,
  one-step, and ceiling authority.
- The route returns 503 when activation is absent/off and 200 only after a live
  model invokes the driver.

## Seven-dimension review

1. **Over-block:** operator mode remains available on demand, and the manual
   route is also available during auto-climb.
2. **Under-block:** model and ceiling both default dark; invalid config cannot
   activate promotion.
3. **Abstraction:** the controller owns activation only; rollout policy remains
   in the existing driver/advancer.
4. **Signal vs authority:** signed E2E evidence remains the promotion gate.
5. **Interactions:** the pre-existing demotion timer is preserved independently.
6. **External surfaces:** one authenticated local HTTP mutation route is added;
   it performs no network call and is classified cluster-shared, so standby
   write admission cannot fork the coherence-critical rollout stage.
7. **Rollback:** set the selector off or revert; no stored data needs repair.

## Class-Closure Declaration

`unbounded-self-action` closes as a **guard**. Auto-climb is rate-bounded to one
tick per minute, each tick can write at most one adjacent stage, and the finite
operator ceiling makes stage mutation settle to zero. The off and operator
models schedule no autonomous promotion. The boundary unit test and real-driver
end-to-end test pin those brakes.

## Evidence

Unit coverage pins both activation boundaries and defaults. Integration coverage
pins dark 503 versus live 200. End-to-end coverage reaches the real server,
route, rollout driver, signed result store, and stage writer.

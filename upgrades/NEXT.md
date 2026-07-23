# Session-pool promotion activation

## What Changed

The multi-machine session pool now has an explicit promotion activation model:
off by default, operator-driven one-step promotion, or cadenced auto-climb.
Both live modes reuse the signed E2E evidence gate and obey a hard operator
ceiling.

## What to Tell Your User

Session-pool rollout can now be advanced deliberately instead of remaining
permanently dark after its tests turn green. Operators can choose manual
one-step control or a cautious automatic climb. Nothing activates by default,
and the separately configured ceiling limits the highest permitted stage.

## Summary of New Capabilities

- `promotionModel` selects off, operator, or auto-climb behavior.
- `POST /session-pool/promote` requests one evidence-gated step in either live
  model and returns 503 while off.
- Automatic promotion runs no faster than once per minute and never crosses
  the configured ceiling.

## Evidence

- `tests/unit/session-pool-promotion-activation.test.ts`
- `tests/unit/PostUpdateMigrator-sessionPoolPromotion.test.ts`
- `tests/integration/session-pool-promote-route.test.ts`
- `tests/e2e/session-pool-promotion-alive.test.ts`

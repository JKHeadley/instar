# Instar Upgrade Guide

## What Changed

When its prerequisite brake pipeline is wired, the existing login-loss
account-swap trigger now reports its resolved enabled and simulation posture on
the proactive-swap status route. Dedicated HTTP integration and end-to-end
tests prove the trigger is inert in simulation and dispatches the exact intent
to the established swap callback only after deliberate promotion.

## What to Tell Your User

Instar's recovery for a conversation whose local account login disappears is
now verified through the same live status and check surface used in production.
You can see whether that recovery is enabled and whether it is still only
simulating its intended move. The default remains safe: ordinary machines are
dark, and development agents record what they would do before any live move is
allowed.

## Summary of New Capabilities

- The proactive-swap status includes the resolved login-loss rollout posture.
- Integration coverage proves low-quota-use login loss triggers a dry-run
  intent without executing a swap.
- End-to-end coverage proves deliberate promotion dispatches the exact intent
  to the existing guarded swap callback and retains the normal dwell brake.

## Evidence

- `tests/integration/subscription-proactive-swap-route.test.ts`
- `tests/e2e/subscription-proactive-swap-lifecycle.test.ts`
- `tests/unit/swap-continuity-wiring.test.ts`
- `tests/unit/proactive-swap-production-wiring.test.ts`

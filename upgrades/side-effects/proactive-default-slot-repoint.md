# Side-Effects Review — proactive default-slot re-point

**Slug:** `proactive-default-slot-repoint`  
**Date:** 2026-10-20  
**Risk:** Tier 2 — credential-routing decision, shipped dark and dry-run-first

## Change and decision points

The ProactiveSwapMonitor now makes one additional decision when at least one untagged session exists: if the resolved default account is at pressure, choose the locally executable same-framework account with the lowest measured binding utilization. Untagged sessions are explicitly removed from both ordinary session-swap candidate builders. The existing set-default endpoint and the monitor share `setDefaultCredentialAccount`; it uses the existing ledger, manual-lever cooldown, audit emitter, and CredentialSwapExecutor.

## Review dimensions

1. **Over-block:** tagged sessions retain their existing path. Untagged sessions no longer receive an unsafe background binding mutation; without an eligible measured target, the feature holds.
2. **Under-block:** the target must be same-framework, locally executable, measured, and below the pressure threshold. Unknown quota is not treated as fresh for this proactive optimization.
3. **Abstraction:** selection stays in ProactiveSwapMonitor; credential-slot resolution and exchange stay in one shared set-default function over the established ledger/executor.
4. **Signal versus authority:** quota is a trigger only. Authority remains doubly gated: the new dev gate plus dry-run, followed by the existing credential executor gate and funnel.
5. **Interactions:** the monitor may run alongside tagged-session swapping. A default-slot failure is caught and audited so it cannot suppress eligible tagged-session decisions in the same pass. Pair cooldown limits repeated exchanges.
6. **External surfaces:** the proactive status response additively reports the new arm's enabled/dry-run posture. No new route or store is added.
7. **Rollback:** disable `subscriptionPool.proactiveSwap.defaultSlotRepoint`; the shared endpoint helper preserves the prior endpoint behavior. No durable data conversion exists.

## Safety invariants

- Dry-run returns before the set-default callback, so it performs zero credential writes.
- No proactive path passes an untagged session to the session-swap callback.
- The shipping default omits `enabled` and sets `dryRun:true`; the fleet is dark.
- No real account was flipped during development or verification.

## Evidence

Unit, integration, and end-to-end tests cover both sides of the pressure/eligibility boundaries, exact freshest-account selection, endpoint sharing, and the session-binding non-mutation invariant. TypeScript compilation is clean.

## Class-Closure Declaration (display-only mirror)

**Class:** `unbounded-self-action` · **Closure:** `guard` · **Enforcement:** ratchet

The registered `proactive-swap-monitor` controller settles after one default-slot re-point because the default resolver then observes the fresh account below pressure. `tests/unit/self-action-convergence.test.ts` is the ratchet and also proves the existing anti-thrash brakes converge under sustained pressure.

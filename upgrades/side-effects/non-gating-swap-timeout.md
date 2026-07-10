# Side-Effects Review — Non-gating swap timeout

**Version / slug:** `non-gating-swap-timeout`
**Date:** `2026-07-10`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`src/core/IntelligenceRouter.ts` now resolves non-gating failure-swap attempt caps from `nonGatingSwapTimeoutMs` instead of the global safety-gating `swapAttemptTimeoutMs`. `src/commands/server.ts` wires the new value from `config.intelligence?.nonGatingSwapTimeoutMs ?? 15000`, and `src/config/ConfigDefaults.ts` seeds that default through normal add-missing init/migration. The associated type, generated awareness text, and unit/integration/e2e tests were updated.

## Decision-point inventory

- `IntelligenceRouter.evaluate` gating/deferrable failure-swap loop — pass-through — still uses `swapAttemptTimeoutMs` and is intentionally unchanged.
- `IntelligenceRouter.tryNonGatingSwap` — modified — chooses the timeout cap for non-gating swap attempts.
- `ConfigDefaults.applyDefaults` migration path — pass-through — add-missing default seeding for the new config field.

---

## 1. Over-block

No new block/allow surface. This change does not reject calls, messages, jobs, or operator actions. It lengthens only the timeout for non-gating swap attempts, so the over-block risk is not a false rejection; the relevant risk is extra wait time on advisory/background calls.

---

## 2. Under-block

This does not change safety-gating fail-closed behavior. A non-gating call can now wait up to 15s for a cold-start provider before falling through, so a genuinely stuck non-gating provider may occupy its attempt for longer than before. The attempt remains bounded, still respects maxAttempts, still excludes Claude/default targets, and still reports timeout degradation.

---

## 3. Level-of-abstraction fit

The router is the right layer because it already owns provider failure-swap attempt timing and timeout propagation to providers. ConfigDefaults is the right layer for the default because the task requires existing agents to receive the knob through add-missing migration while preserving operator overrides.

---

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

This is a timeout policy split inside an existing retry mechanism. It does not add a detector or an authority, and it does not make a semantic decision about user intent or message meaning.

---

## 5. Interactions

- **Shadowing:** The non-gating helper now has its own global fallback cap. Per-target framework caps still shadow it when configured for a target, preserving the existing specificity order.
- **Double-fire:** No new reporter path is added. Existing timeout degradation reasons continue to fire when an attempt times out.
- **Races:** No shared mutable state is added. The cap is read from router options and applied per call.
- **Feedback loops:** Longer non-gating waits can reduce heuristic fallback churn but do not change retry counts, scheduler cadence, or provider circuit-breaker rules.

---

## 6. External surfaces

Operators get a new config knob: `intelligence.nonGatingSwapTimeoutMs`, default 15000. Existing config migration adds the missing value and preserves explicit overrides. Existing agent awareness text now mentions the knob. No Telegram, Slack, GitHub, Cloudflare, dashboard UI, persistent database schema, or URL surface changes. No operator-facing action is added.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture

Machine-local by design. This is per-agent runtime configuration read from that agent's local `.instar/config.json`. On multi-machine setups, each machine may tune the timeout to its own provider startup behavior. It emits no user-facing notices directly, holds no new durable state beyond config defaults, and generates no URLs.

---

## 8. Rollback cost

Hot-fix release: revert the router option, config default, server wiring, awareness text, and tests. No data migration or agent state repair is needed. Existing configs that received `nonGatingSwapTimeoutMs: 15000` would carry an unused field after rollback, which is harmless.

---

## Conclusion

Clear to ship. The change fixes the observed cold-start timeout without slowing safety gates. The main side effect is intentional: non-gating internal calls may wait longer before falling back to heuristics, but the wait remains bounded and scoped away from the gating fail-closed path.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

---

## Evidence pointers

- `instar dev:claim-check src/core/IntelligenceRouter.ts src/core/types.ts src/config/ConfigDefaults.ts src/commands/server.ts src/core/PostUpdateMigrator.ts src/scaffold/templates.ts`
- `npm test -- tests/unit/nongating-failure-swap.test.ts tests/unit/ConfigDefaults.test.ts tests/unit/PostUpdateMigrator-nonGatingFailureSwap.test.ts tests/integration/nongating-failure-swap-routing.test.ts tests/e2e/nongating-failure-swap-lifecycle.test.ts`

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller addition — not applicable.

# Side-effects review — Phase 5c cost-aware routing infrastructure

**Version / slug:** `phase-5c-cost-aware-routing`
**Date:** `2026-05-15`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (pure-function policy + tracker with deterministic decision matrix; full unit-test coverage of every branch)
**Driving spec:** `specs/provider-portability/11-cost-aware-routing.md` (locked + approved 2026-05-15) which implements §"Routing default" of `04-anthropic-path-constraints.md`

## Summary of the change

Phase 5c adds the deterministic routing math that sits below the Phase 5b UX. Two new classes live in `src/providers/costAwareRouting.ts`:

1. **`CostAwareRoutingPolicy`** — implements the existing `RoutingPolicy` interface from `src/providers/routing.ts`. Given a candidate adapter list and a `readSdkCredit()` function, returns a `RoutingDecision` that picks SDK-credit-path when the credit pot is above the safety margin (default 10% of monthly total), subscription-floor otherwise. Six-row decision matrix (both/SDK-only/subscription-only × healthy/below-margin/unknown). Throws when neither Anthropic candidate is in scope so `ChainPolicy` defers to the next policy.

2. **`CostStateTracker`** — emits structured `CostStateSnapshot` objects Phase 5b's TriggerGate uses to detect "material" cost shifts between cached preferences. Three material-shift categories: crossed safety margin (either direction), drifted ≥25% of total since prior snapshot, or known↔unknown state transition.

23 unit tests cover every row of the decision matrix, the three material-shift categories, option validation, and the documented default constants.

This phase is purely additive infrastructure. It is NOT wired into the runtime — `Registry.setRoutingPolicy()` is not called from any composition root in this commit. Wiring happens at server startup as part of Phase 5b's implementation (next phase).

Files touched:
- `src/providers/costAwareRouting.ts` — new, 199 LOC, contains both classes + constants + types.
- `tests/unit/providers/costAwareRouting.test.ts` — new, 23 cases.
- `specs/provider-portability/11-cost-aware-routing.md` — new spec, locked + approved 2026-05-15.
- `specs/provider-portability/11-cost-aware-routing.eli16.md` — mandatory ELI16 companion.

## Decision-point inventory

This change ADDS decision-point surface. It is itself a decision point — picks which adapter handles an Anthropic-bound request — and its implementation interacts with the existing `RoutingPolicy` / `ChainPolicy` decision chain.

- **`CostAwareRoutingPolicy.decide(candidates, request)`** — `add`. The new authority for SDK-credit-vs-subscription routing of Anthropic-bound traffic.
- **`CostStateTracker.snapshot()`** — `add`. Pure-observability signal source. No blocking authority. Phase 5b reads the snapshot but the tracker doesn't gate anything itself.
- **`CostStateTracker.isMaterialShift(prior, current)`** — `add`. Pure function — returns a reason string or null. Phase 5b's TriggerGate is the authority that decides what to do with the reason.

No existing decision points are modified. The existing `RoutingPolicy` / `ChainPolicy` / `FirstAvailablePolicy` interfaces in `src/providers/routing.ts` are unchanged.

## Signal vs authority

- `CostAwareRoutingPolicy` is an authority — it returns a `chosen` adapter id that the registry uses. Authority scope is narrow: only Anthropic-stack candidates. Outside that scope it throws so `ChainPolicy` defers.
- `CostStateTracker` is a signal producer only. It captures snapshots and computes deltas. It never blocks. The downstream authority (Phase 5b's TriggerGate) interprets the signal.
- Both classes are pure-input-pure-output where possible. The `readSdkCredit` function is the only external dependency; both classes tolerate its absence/failure without panicking.

## Over-block / under-block analysis

**Over-block:**
- A flaky `readSdkCredit` (transient null/throw) routes all work to subscription floor until it recovers. Subscription floor is always-correct per Rule 1, so this is graceful degradation, not over-block.
- A misconfigured `safetyMarginFraction = 1.0` (rejected at construction by option validation) would route everything to subscription regardless of credit. Construction-time validation prevents this.

**Under-block:**
- A reader that returns stale data (cached snapshot from minutes ago) could pick SDK adapter when the pot has actually drained since the cache. Bounded by however quickly the caller refreshes the reader. Recommended: call `readSdkCredit` per-decision, not per-app-lifetime.
- The `materialDriftFraction = 0.25` threshold means Phase 5b won't re-ask for drift < 25%. A user who'd want awareness at, say, 10% drift would need to override the option. Defaults are intentionally permissive to avoid prompt spam.

## Level-of-abstraction fit

- The policy lives in `src/providers/costAwareRouting.ts` (parallel to `src/providers/routing.ts` where the interface lives). It depends only on `RoutingPolicy`, `ProviderAdapter`, `AgentSdkCreditSnapshot`. No knowledge of specific adapter internals.
- The tracker shape (`CostStateSnapshot`) is the contract Phase 5b will consume. Defining it here keeps Phase 5b free of Anthropic-specific details — future tracker extensions (subscription-window state, per-provider budgets) extend the snapshot shape without rewriting Phase 5b.

## Interactions

- **Existing `RoutingPolicy` / `ChainPolicy`** — composes naturally. The recommended chain (`PinHonoring → CostAware → FirstAvailable`) is documented in the spec but not constructed in this commit.
- **`UsageMeterProvider`** — typical `readSdkCredit` implementation wraps a `UsageMeterProvider.read()` call and extracts `agentSdkCredit`. This commit does not include the wrapper because the application-layer wiring happens during Phase 5b implementation.
- **No changes to existing source files.** Pure addition. Zero regression surface.

## External surfaces

- `CostAwareRoutingPolicy` — new exported class.
- `CostStateTracker` — new exported class.
- `CostAwareRoutingOptions`, `CostStateTrackerOptions`, `CostStateSnapshot` — new exported types.
- `DEFAULT_SAFETY_MARGIN_FRACTION` — new exported const (0.10).
- No new endpoint, no new CLI command, no new config field. Wiring is composition-root concern.

## Rollback cost

Trivial. `git revert` removes one source file + one test file + two spec files + this artifact. No persistent state, no runtime callsites. Zero blast radius.

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/costAwareRouting.test.ts` — 23/23 pass.
- Branch coverage: every row of the decision matrix has at least one passing case; every material-shift category has at least one passing case; option-validation rejects out-of-range fractions.
- No real-API verification needed — `readSdkCredit` is a pure function dependency stubbed in tests. Production wiring (where `readSdkCredit` becomes a `UsageMeterProvider` call) gets real-API verification as part of Phase 5b implementation.

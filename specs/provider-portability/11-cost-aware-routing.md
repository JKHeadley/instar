---
review-convergence: "2026-05-15T00:00:00Z"
approved: true
approved-by: "Justin (JKHeadley)"
approved-date: "2026-05-15"
---

# Phase 5c — Cost-Aware Routing Infrastructure

**Status:** Active, spec landed 2026-05-15
**Branch:** `spec/provider-portability`
**Phase position:** Implements the "Routing default" section of `04-anthropic-path-constraints.md`. Sits below Phase 5b (suggest-and-confirm UX) — 5b reads the routing decision and the cost-state snapshot this layer produces.
**Companion:** ELI16 overview at `11-cost-aware-routing.eli16.md`.

---

## What this spec defines

The deterministic, stateless-from-the-caller's-view layer that, given a set of Anthropic candidate adapters and the current SDK credit pot state, picks which one runs the work. Plus a `CostStateTracker` that emits structured snapshots Phase 5b uses to detect "material" cost shifts between cached routing picks.

This layer makes no user-facing decisions. It does not prompt, log to channels, or send Telegram messages. It is the pure routing math that the Phase 5b UX rides on top of.

---

## Decision matrix

Inputs:
- A candidate list (already filtered by the registry to adapters that satisfy the request's required capabilities).
- A `readSdkCredit()` function that returns an `AgentSdkCreditSnapshot | null`. Null means "state unknown" (provider unreachable, fresh boot, etc.).
- A `safetyMarginFraction` (default 0.10) — the fraction of the pot's `totalUsd` to preserve as headroom.

Outputs: a `RoutingDecision` with `chosen` adapter id, `reason` string, and an optional `fallbacks` chain (used by retry logic when the chosen adapter fails at use time).

The matrix:

| Candidate set | SDK credit state | Decision |
|---|---|---|
| Both SDK and subscription adapters | remaining > margin | SDK adapter (drain-first) |
| Both SDK and subscription adapters | remaining ≤ margin | Subscription adapter (preserve headroom) |
| Both SDK and subscription adapters | unknown (read returned null or threw) | Subscription adapter (conservative) |
| Only SDK adapter | any | SDK adapter |
| Only subscription adapter | any | Subscription adapter |
| Neither Anthropic adapter | any | Throw — `ChainPolicy` defers to next policy |

The throw on "neither Anthropic adapter" is intentional. The cost-aware policy only governs Anthropic-stack routing; non-Anthropic providers (Codex, Gemini, OSS) are routed by sibling policies in the chain.

---

## Safety margin semantics

The default `safetyMarginFraction = 0.10` (10%) preserves enough credit pot headroom that an unexpected burst of high-priority work doesn't immediately collapse to the subscription floor. Tuning notes:

- **Lower margin (e.g., 0.05)** — wrings more of the prepaid pot through. Risk: tight tail; a single bad day can push the pot below margin and force subscription routing for the rest of the period.
- **Higher margin (e.g., 0.25)** — leaves more buffer but wastes prepaid credit that won't roll over. Use when the user explicitly wants "preserve credit for emergencies."
- **0.0** — equivalent to "drain the pot completely before falling back." Allowed by the option but not the default.
- **1.0** — equivalent to "never use SDK credits even if available." Allowed; rejected at construction with values outside [0,1].

The margin is recomputed every decision call against the snapshot's `totalUsd`. Resets are handled implicitly when the snapshot refreshes to a new billing period.

---

## CostStateTracker — the Phase 5b bridge

Phase 5b's `TriggerGate` needs to answer: "since the last time we cached a routing pick for this task pattern, has anything materially changed?" The tracker provides that answer.

### Snapshot shape

```ts
interface CostStateSnapshot {
  capturedAt: string;          // ISO timestamp
  agentSdkCredit?: {
    remainingUsd: number;
    totalUsd: number;
    safetyMarginUsd: number;
    belowMargin: boolean;
    consumedFraction: number;  // 0..1
  } | null;
}
```

The cached row Phase 5b's `PreferenceStore` writes carries the snapshot from when the cache row was created. On future lookups, the gate runs `isMaterialShift(cachedSnapshot, currentSnapshot)` and re-asks if a reason is returned.

### "Material" shift definition

A shift is material when ANY of the following hold:

1. **Crossed the safety margin.** The SDK pot transitioned across the boundary in either direction. Cache made above margin / current below → SDK→subscription flip; cache made below / current above → subscription→SDK flip.
2. **Drifted by `materialDriftFraction` (default 0.25) of totalUsd.** Even without crossing margin, a big consumption since the cache invalidates the assumption the user signed off on.
3. **Observability transitioned.** Known→unknown (provider went away) or unknown→known (state newly available). Either one changes what a routing decision can be based on.

Drift smaller than the threshold while both snapshots stay on the same side of the margin is NOT material. The tracker is intentionally conservative — false-positives mean spamming the user with unneeded confirmation prompts.

---

## Composition with other policies

The `RoutingPolicy` interface and `ChainPolicy` already exist in `src/providers/routing.ts`. The recommended chain for v1.0.0 is:

```ts
new ChainPolicy([
  // 1. Honor an explicit pin (the user said "use Codex for this one")
  new PinHonoringPolicy(),
  // 2. Anthropic-stack routing
  new CostAwareRoutingPolicy({ readSdkCredit, sdkCreditAdapterId, subscriptionAdapterId }),
  // 3. Other providers — first-available for now; benchmarking adds preferences in Phase 5d
  new FirstAvailablePolicy(),
]);
```

`CostAwareRoutingPolicy` throws when neither Anthropic adapter is in the candidate set, which causes `ChainPolicy` to skip it and try the next policy. This is the contract — keep it.

---

## What's explicitly NOT in Phase 5c

- The actual Phase 5b UX (Telegram prompts, preference store, override detector). 5c emits the decision and the snapshot; 5b decides whether to ask.
- Catalog-version awareness. The catalog (model fitness, framework fitness) is a separate Phase 5a artifact. 5b's TriggerGate consults the catalog separately.
- Routing for non-Anthropic stacks. Codex, Gemini, OSS adapters route via sibling policies (Phase 5d adds benchmark-aware preferences).
- Live wire-up to the runtime. The policy is built and unit-tested. Wiring it into `Registry.setRoutingPolicy()` happens at composition root — server startup — as part of Phase 5b's implementation.
- Persistence of routing decisions for audit. Future observability work.

---

## Acceptance criteria

Phase 5c is complete when:

1. `CostAwareRoutingPolicy` implements `RoutingPolicy` and covers the six-row decision matrix above.
2. `CostStateTracker.isMaterialShift` returns a non-null reason for each of the three material-shift categories and null for non-material drift.
3. Unit-test coverage: 20+ cases across both classes — at least one for each row of the decision matrix and each of the three shift categories.
4. Option validation rejects out-of-range `safetyMarginFraction` at construction.
5. Documented default `DEFAULT_SAFETY_MARGIN_FRACTION = 0.10` exported for reuse.
6. The policy throws (rather than picking) when no Anthropic candidate is in scope, so `ChainPolicy` can defer.
7. ELI16 companion exists and is shipped with the spec.

---

## References

- `04-anthropic-path-constraints.md` §"Routing default (locked 2026-05-15 by Justin)" — the canonical routing rules this implements.
- `10-suggest-and-confirm-ux.md` — the Phase 5b consumer of this layer's outputs.
- `src/providers/primitives/observability/usageMeterProvider.ts` — source of the `AgentSdkCreditSnapshot` shape.
- `src/providers/routing.ts` — `RoutingPolicy` interface and `ChainPolicy` this composes with.

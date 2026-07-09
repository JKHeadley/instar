---
title: "Non-Gating Failure-Swap — bounded provider swap for non-gating internal calls"
slug: "nongating-failure-swap"
author: "echo"
parent-principle: "No Silent Degradation to Brittle Fallback"
eli16-overview: "docs/specs/nongating-failure-swap.eli16.md"
tier: 1
---

# Non-Gating Failure-Swap — bounded provider swap for non-gating internal calls

**Status:** Tier-1 bug fix (bounded extension of the converged + approved
`provider-fallback-default-policy.md` mechanism).
**Author:** echo
**Parent:** `docs/specs/provider-fallback-default-policy.md` (CONVERGED, approved).

## 1. Problem (grounded in production metrics, 2026-07-09)

`TopicIntentExtractor` — a NON-gating background component routed to `codex-cli` /
`gpt-5.4-mini` by the provider-fallback default policy — showed a **28% error rate**
(122 errors / 428 calls over 7 days) in live `/metrics/features`. Every error row had
`errorRowsWithUsage: 0`: the codex `exec` invocation itself failed / timed out / returned
empty, producing ZERO tokens. It was **not** a rate-limit (codex account ~3% used) and
**not** a content/parse error (those carry tokens).

Meanwhile `MessagingToneGate` (a GATING call, off-Claude, pi-cli) errored at 1.5% and
`CoherenceReviewer` (gating, multi-framework) at 2.6% — because **gating calls ride the
failure-swap tail**: when the primary provider fails at runtime, they swap down the active
chain (codex → pi → gemini → claude), each circuit-checked and bounded by
`intelligence.swapAttemptTimeoutMs`.

The gap: the failure-swap in `IntelligenceRouter.evaluate()` is scoped to
`attribution.gating === true` (and deferrable calls). A NON-gating call whose primary
INVOCATION fails **hard-errors straight to the caller's heuristic** — even when a healthy
off-Claude fallback door (pi-cli, 1.5%) exists. So a transient codex-exec flakiness surfaces
as a 28% user-visible error rate on a component that had a perfectly good place to swap.

### Why the exclusion existed (and why extending it is correct, not wrong)

The gating-only scope is DELIBERATE and documented (provider-fallback §6.2, and the inline
comment at `IntelligenceRouter.ts` above the `gating` computation): a naive Codex→Claude
fallback under a broad rate-limit could create a synchronized **herd onto Claude**. Scoping
the swap to the small set of safety-gating callers keeps that herd tiny; non-gating calls
"just propagate the error to their existing heuristic … so they never herd onto a fallback
provider."

That herd concern is real but **narrow** — it is about herding non-gating background traffic
onto the last-resort Claude tail. This fix honors it exactly by making the non-gating swap
**strictly more conservative** than the gating swap (see §2), so it never reintroduces the
herd the exclusion guards against. The exclusion is therefore not load-bearing against this
fix; it is load-bearing against a *naive* extension, which this is not.

## 2. The fix (minimal, bounded)

Extend the failure-swap to non-gating internal calls, with a TIGHTER bound than gating calls:

- **Swap only on an INVOCATION-level failure.** The primary threw AND produced ZERO tokens
  (spawn failure / timeout / empty output). A content/parse error that CARRIED tokens does
  NOT swap — the caller fail-opens it (provider-fallback §6.4). Observability: the router
  composes an `onUsage` capture onto the primary attempt; a provider that surfaces any tokens
  before failing marks the failure as token-carrying (no swap). A provider that never surfaces
  usage (gemini-cli) leaves the flag false → treated as invocation-level (the conservative,
  error-reducing direction when unobservable).
- **At most `maxAttempts` (default 1) steps** down the active config `failureSwap` tail — each
  target circuit-checked (binary-missing / circuit-open → skipped) and bounded by the SAME
  per-attempt cap machinery the gating loop uses (`resolveSwapCap` + `withSwapTimeout`, the cap
  also flowed through as the provider's `timeoutMs`).
- **NEVER onto `claude-code` or the default framework.** This is the load-bearing herd-safety
  invariant (§6.2): non-gating background traffic must never herd onto the last-resort Claude
  tail. If the only remaining tail entry is claude-code, the non-gating call re-throws to its
  heuristic (today's behavior) — no herd.
- **Metrics honesty (Token-Audit Completeness).** No new recording is added: each provider's
  own `CircuitBreakingIntelligenceProvider` records its own feature_metrics row keyed by the
  serving framework/model — the failed codex primary keeps its zero-usage error row, the pi
  swap records pi's success row with pi's usage/model. `usageCoverage` is unaffected.

Scope: the non-gating swap applies to the LEGACY category-routing path (the computed default's
`cfg.failureSwap`). A nature-routing-ENFORCED call (dev-gated dark) is untouched — that is a
separate feature's concern.

## 3. Config

A single new knob under `intelligence`, INLINE-DEFAULTED at the router construction site (the
`codexExecJson` / `swapAttemptTimeoutMs` precedent — deliberately kept out of
`ConfigDefaults` / `migrateConfig`, so absence is the default state, never a persisted block):

```
intelligence.nonGatingFailureSwap: { enabled?: boolean; maxAttempts?: number }
```

- `enabled` defaults **TRUE** (server construction: `?? true`). Ships ON: it strictly reduces
  user-visible errors and the one-step + Claude-exclusion bound keeps cost/herd flat — the same
  "ships enabled, no-op where inert" reasoning as the parent provider-fallback policy (§9).
- `maxAttempts` defaults 1 (an invalid/absent value → 1).
- `{ enabled: false }` restores today's behavior (a non-gating invocation failure re-throws to
  the caller's heuristic with no swap). A router constructed WITHOUT the field at all (e.g. a
  unit test) is also OFF — byte-identical to before.

## 4. Safety

- **Fail-closed / fail-open unchanged.** The non-gating path only ever ADDS a bounded chance to
  succeed before the SAME heuristic-fallthrough the caller already used. Every failure path still
  ends at `throw err` → the caller's heuristic (tracked via `onHeuristicFallthrough`).
- **Herd-bounded.** One step, circuit-checked, never onto Claude → strictly more conservative
  than the gating full-tail swap. Cannot recreate the §6.2 herd.
- **No change to** gating-call behavior, deferrable behavior, `sessions.componentFrameworks`
  semantics, the spawn-cap funnel, or nature-routing.

## 5. Tests (all three tiers)

- **Unit** (`tests/unit/nongating-failure-swap.test.ts`): invocation-failure → one swap to the
  next active framework; content-error-with-usage → NO swap; disabled/absent → old behavior;
  circuit-open/down target → skip + re-throw original; herd-safety (never onto claude-code /
  default, while gating still does); maxAttempts bound; model-tier preserved; slow target
  abandoned at the cap; gemini-primary (no usage) → conservative swap.
- **Integration** (`tests/integration/nongating-failure-swap-routing.test.ts`): a
  production-shaped router (computed default + the knob) performs the swap; `GET
  /intelligence/routing` is unchanged (resolution, not swap); `{ enabled:false }` hard-errors.
- **E2E** (`tests/e2e/nongating-failure-swap-lifecycle.test.ts`): the real AgentServer init path,
  the shipped default expression resolves `enabled:true`, the wired router performs the swap
  (feature alive, not dark).

## 6. Agent awareness + migration parity

- `generateClaudeMd()` gains a bullet under Per-Component Framework Routing (new agents).
- `migrateClaudeMd()` appends a content-sniffed corrective subsection (existing agents) —
  marker `non-gating internal calls also get a bounded`. Covered by
  `tests/unit/PostUpdateMigrator-nonGatingFailureSwap.test.ts`.

## Open questions

*(none — single-run completable; the tier/herd/metrics decisions are all resolved above.)*

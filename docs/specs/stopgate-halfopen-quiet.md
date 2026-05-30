---
title: Stop-gate breaker — half-open retry reports breakerOpen (stop the per-cooldown /health degradation creep)
date: 2026-05-30
author: echo
review-convergence: robustness-residual-2026-05-30
approved: true
approved-by: Justin
approved-via: 12h autonomous mentorship+robustness session mandate — "any Instar robustness or Codex issue I find, I fix as a proper fleet PR (full ship-gate)". This is a robustness residual-fix for the shipped stop-gate breaker (#559). Reported to Justin in topic 13435.
eli16-overview: stopgate-halfopen-quiet.eli16.md
---

# Spec — Stop-gate breaker half-open quiet

**Date:** 2026-05-30
**Author:** echo
**Status:** approved (robustness residual-fix for #559)

## Context

The UnjustifiedStopGate circuit breaker (#559, v1.3.112) fixed the chronic
`/health` degraded-flood on subscription agents: the gate Haiku-judges every Stop
via a ~5-6s `claude -p` subprocess against a ~2s budget, so it times out on EVERY
stop — fail-opening (correct) but wastefully spawning+killing a subprocess and
emitting one `DegradationReport` per stop. The breaker opens after K consecutive
provider failures and short-circuits (no spawn, no degradation) for a cooldown,
then half-open-retries once.

## Problem (observed live)

After the breaker deployed, the degradation count still **slowly grew** (observed 3
→ 10 over ~40 min) and `/health` stayed `degraded`. Root: once open, the breaker's
periodic **half-open retry probe** calls the still-unavailable provider once per
cooldown. That call times out and `evaluate()` returned `timeout` /
`llmUnavailable` — each of which the route reports as a fresh `DegradationReport`.
So every cooldown re-emitted one degradation, climbing the count and keeping
`/health` degraded long after the breaker had already stopped the actual flood +
subprocess churn. Cosmetic (the flood + waste were fixed) but a misleading signal.

## Fix

In `evaluate()`'s catch, after `onProviderFailure()`: if that failure (re)opened
the breaker (`now < breakerOpenUntil`), report the outcome as `breakerOpen` instead
of `timeout` / `llmUnavailable`. The route already suppresses `breakerOpen` from
degradation reporting (#559), so:

- The first **threshold-1** failures still report `timeout`/`llmUnavailable` and
  emit a degradation (informative — the provider is failing).
- The threshold-th failure (which opens the breaker) and every subsequent
  half-open retry (which re-opens it) report `breakerOpen` — suppressed.

So the degradation count caps at threshold-1 (default 2) and never creeps. The
fail-open DECISION is unchanged (`breakerOpen` allows the stop exactly like
`timeout`); only the degradation-emission of the breaker-(re)opening failure
changes. `breakerThreshold: 0` (disabled) is respected — `onProviderFailure()`
returns early, `breakerOpenUntil` stays 0, and failures report
`timeout`/`llmUnavailable` as before.

## Testing

- `tests/unit/UnjustifiedStopGate-breaker.test.ts` — updated "opens after
  threshold" (the opening failure now reports breakerOpen; count of provider calls
  unchanged); strengthened "retries half-open" (the retry reports breakerOpen);
  new dedicated regression: threshold=1, walk 4 cooldowns, every half-open retry
  reports breakerOpen, never timeout/llmUnavailable. `breakerThreshold=0` and
  "reachable resets" and "real timeout counts" tests pass unchanged.
- Full gate/router-hook suites (18 + 2) green; no regression.

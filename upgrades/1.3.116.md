# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The stop-gate circuit breaker no longer slowly creeps the `/health` degradation
count while it's open.**

Follow-up to the breaker shipped in #559. Once the breaker is open, it does one
half-open retry probe per cooldown to check whether the (still-unavailable)
provider has recovered. That probe timed out and `evaluate()` returned
`timeout`/`llmUnavailable`, each of which the route reports as a fresh
`DegradationReport` — so the count climbed ~1 per cooldown (observed 3 → 10 over
~40 min) and `/health` stayed `degraded` long after the breaker had already
stopped the actual flood + subprocess churn.

Fix: when a provider failure (re)opens the breaker, `evaluate()` now reports
`breakerOpen` instead of `timeout`/`llmUnavailable`. The route already suppresses
`breakerOpen` from degradation reporting, so the half-open retry stops emitting a
fresh degradation each cooldown. The count caps at `breakerThreshold - 1` and
`/health` can return to `ok`. The fail-open decision is unchanged.

## What to Tell Your User

After the earlier circuit-breaker fix, my health page could still slowly drift into
"degraded" and stay there — not because anything was wrong, but because the breaker
does a routine self-test once per cooldown, and each self-test was being logged as a
brand-new problem. I changed that self-test to be recognized as the breaker's normal
"still cooling down" state instead of a fresh fault, so it stops piling up false
"degraded" notes. My health signal is now honest again — if it says degraded, it
means something. Nothing about how I actually behave changed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quiet half-open breaker retry | Automatic — the breaker's per-cooldown self-test no longer emits a health degradation |

## Evidence

- **Live observation:** with the breaker deployed (v1.3.112) the degradation count
  climbed from 3 to 10 over ~40 minutes — one per cooldown from the half-open retry
  probe — and the health status stayed degraded.
- **Tests:** `tests/unit/UnjustifiedStopGate-breaker.test.ts` — updated the
  threshold-opening assertion, strengthened the half-open assertion, and added a
  dedicated regression that walks 4 cooldowns and verifies every half-open retry
  reports the suppressed breaker-open kind, never a fresh timeout. Full gate +
  router-hook suites (18 + 2) green.
- Spec: `docs/specs/stopgate-halfopen-quiet.md`. Side-effects:
  `upgrades/side-effects/stopgate-halfopen-quiet.md`.

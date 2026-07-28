# Herd-Aware Provider-Swap — Plain-English Overview

> The one-line version: when a safety gate's AI is rate-limited, instead of giving up (and falling back to weak code), it tries your OTHER AI providers first — and only fails closed if every one is down.

## The problem in one breath

We just made the safety gates fail closed when their AI is down. That's safe, but it means more things pause for approval during a rate-limit. The better answer: don't fail at all if another AI provider is available — swap to it.

## What already exists

- **One shared AI router** that every gate and sentinel calls. It already routes different components to different AI frameworks (Claude, Codex, Pi) and gives each its own circuit breaker.
- **The fail-closed gates** (from the previous change) — on an AI failure they require approval / hold, rather than silently proceeding.

## What this adds

A **failure-swap** at that one router. When a SAFETY-GATING call's AI fails, the router walks a configured ordered list of fallback frameworks, **skips any whose circuit is already open** (so it never piles load onto a provider that's also struggling), and serves the answer from the first healthy one. Only if every provider is down does it fail closed.

## The new pieces

- **`failureSwap` config** — an ordered list of frameworks to try on a gating call's failure (e.g. Codex, then Pi). Default: empty = today's behavior, nothing changes unless you turn it on.
- **A `gating` flag** on the call — only safety-gating calls swap. This keeps the "herd" tiny: a rate-limited framework can't dump its whole load onto another, because only the few real gates swap (advisory calls keep degrading as before).

## The safeguards

**Prevents herding.** The original router deliberately didn't swap, to avoid a rate-limited framework dumping all its traffic onto the fallback at once. This keeps that protection two ways: only gating calls swap (small set), and any fallback whose circuit is already open is skipped instantly.

**Fail-closed is still the floor.** If every provider is down, the error re-throws and the gate fails closed — never a silent drop to weak code.

**Generalizes to all your providers.** Claude, Codex, Pi, and Copilot-via-Pi are each a separate account/quota, so the same model reachable through multiple paths is redundancy. Composes with the subscription-pool (which manages accounts within a provider).

## What ships when

This PR is the router swap + the gating flags on the five safety gates. Follow-ups: a model-family-diverse default order, the lint, the iterative re-audit to convergence, and the throwaway-agent test harness.

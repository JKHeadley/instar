# Interactive-pool canary graceful degradation — Plain-English Overview

> The one-line version: when my server starts a pool of reusable Claude sessions (the cheaper "subscription" path), it runs a tiny self-test on the first one. If that self-test failed, the WHOLE pool refused to start — which dumped all my AI work onto the pay-per-use credit pot and, on a busy machine where the self-test was just slow, kept failing and tripping a circuit breaker over and over. Now a failed self-test just logs a warning and lets the pool start anyway.

## The problem in one breath

There's a startup "empty-prompt canary": send a trivial prompt to a freshly-spawned pool session and check the reply, to learn how that session signals an empty/no-op response. If the canary returned a failure, the code **threw an error** — and because all the pool sessions are started together, one failure made the entire pool fail to start. With no pool, my Anthropic work fell back to the metered Agent-SDK credits, and under load (where the canary's round-trip was just slow/garbled, not truly broken) it re-failed on every start attempt and tripped the "pause all LLM work" circuit breaker in a loop.

## What already exists

- **The interactive pool** — a set of reusable Claude REPL sessions that serve my background AI calls off my subscription instead of metered credits. Opt-in; dark by default; live on this agent.
- **The empty-prompt canary** — a startup self-test that derives how a session reports an empty response. It's a quality/detection aid, not the thing that makes the session able to answer real prompts.
- **Per-call resilience** — if an actual prompt to a pool session fails, the pool already retires that session and spawns a replacement, and emits degradation events.

## What this adds

It changes one decision: **a failed startup canary no longer refuses the whole pool.** Instead of throwing (which killed pool startup), the code now reports the degradation and brings the session ready anyway. The empty-prompt detection runs in best-effort mode for that lifetime; the pool serves real work normally.

This simply makes the *structured-failure* path behave like the *canary-crashed* path right next to it, which was **already** non-fatal — the code there literally says "missing canary is protection-in-depth, not a primary failure path." The two paths are now consistent.

## The safeguards

**A genuinely broken session is still caught.** Not killing it at startup doesn't mean a dead session lingers: the first real prompt that fails triggers the existing retire-and-replace path, and the recurring canary keeps probing. So "truly broken" is handled by the per-call machinery instead of by refusing service to everyone.

**The failure is still surfaced, not swallowed.** A canary fail still reports to the DegradationReporter, so the unverified-signature state is visible — it's just no longer fatal.

**Normal operation is untouched.** When the canary passes (the common case), nothing changes. Only the fail-at-startup behavior changed, and only to stop the total outage.

## What ships when

One PR, one file plus its test. The pool stays opt-in. No new API, config, or migration.

## Evidence

`pool-canary-graceful.test.ts`: source guards that the canary-fail branch no longer throws, no longer kills/deletes the session, still reports a degradation, and that `spawnOne` reaches the ready transition after the canary block. The existing 53 interactive-pool unit tests pass unchanged; `tsc --noEmit` clean. causalAutopsy: latent — the structured-fail branch was fatal from the start while the adjacent infra-error branch was non-fatal; the inconsistency only surfaced as a circuit-tripping outage once a busy box made the canary round-trip slow enough to "fail."

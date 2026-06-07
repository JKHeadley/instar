<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

The subscription-path interactive pool's startup empty-prompt canary used to `throw` on
a structured failure, which rejected `start()`'s `Promise.all` and made the **entire
pool refuse to start** — stranding all Anthropic work onto the SDK credit pot and, under
transient CPU starvation (a slow/garbled canary round-trip), re-failing every spawn and
tripping the LLM circuit breaker in a loop (2026-06-07 "server temporarily down on every
message", topic 21816). A canary failure now **degrades gracefully**: it reports the
degradation and brings the session ready anyway, so the pool serves real prompts and
empty-prompt detection runs best-effort for that lifetime. This makes the structured-fail
path consistent with the adjacent canary-infra-error path, which was already non-fatal.

## What to Tell Your User

If the cheaper subscription path went dark and everything fell back to metered credits
(with repeated "pausing all LLM work" circuit trips) during a busy period: a failed pool
self-test no longer takes the whole pool down. Nothing for them to do.

## Summary of New Capabilities

- `InteractivePool.spawnOne` treats a startup empty-prompt canary `status: 'fail'` as
  non-fatal: report the degradation, keep the canary marked as run, bring the session
  ready (no throw, no session kill). A genuinely broken session is still caught by the
  existing per-call retire/replace path.

## Scope (honest)

Contained Tier-1 change to one conditional in one file
(`src/providers/adapters/anthropic-interactive-pool/pool.ts`). The pool is opt-in
(subscription-path). Normal (canary-passes) operation is unchanged. No new API/route/
config/migration. Note: Justin already stabilized this live during the incident; this is
the durable code fix so it can't recur.

## Evidence

`pool-canary-graceful.test.ts`: source guards that the canary-fail branch no longer
throws, no longer kills/deletes the session, still reports a degradation, and that
`spawnOne` reaches the ready transition after the canary block. The existing 53
interactive-pool unit tests pass unchanged; `tsc --noEmit` clean; no-silent-fallbacks
budget unaffected (removes a throw, adds no catch). causalAutopsy: latent — the
structured-fail branch was fatal from the start while the adjacent infra-error branch
was non-fatal; surfaced as a circuit-tripping outage only once a busy box made the canary
round-trip slow enough to "fail."

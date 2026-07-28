# Side-Effects Review — Interactive-pool startup canary graceful degradation

**Version / slug:** `pool-canary-graceful-degradation`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (one-branch behavior change in a dark provider; no API/route/config/migration)
**Second-pass reviewer:** `Echo (self) — Tier-1; the "what does a canary fail now mean" analysis below is load-bearing`

## Summary of the change

The subscription-path interactive pool's startup empty-prompt canary (`spawnOne` in
`pool.ts`) USED to `throw` on a structured `canaryResult.status === 'fail'`. That throw
rejected `start()`'s `Promise.all`, so the **entire pool refused to start** — stranding
all Anthropic work onto the SDK credit pot and, under transient CPU starvation (a
slow/garbled empty-prompt round-trip), re-failing every spawn and tripping the LLM
circuit in a loop (2026-06-07 topic 21816). The canary-fail branch now degrades
gracefully: it reports the degradation and brings the session **ready** anyway, instead
of throwing / killing the session. File: `src/providers/adapters/anthropic-interactive-pool/pool.ts`.

## Decision-point inventory

- `spawnOne` canary-fail branch — modify — was "report + kill session + throw"; now
  "report + continue to ready". The only decision: does a failed empty-prompt-signature
  verification refuse the whole pool, or degrade detection to best-effort. It now degrades.
- The canary **infra-error** branch (an exception from the canary itself) was ALREADY
  non-fatal (logged, didn't block) — this change makes the structured-fail branch
  consistent with it.
- No message block/allow surface. No new route/config/migration.

## 1. Over-refuse (the bug being fixed)

Previously a single canary fail refused ALL pool service. Now it never does. This is
strictly safer for availability: the worst outcome of an unverified empty-prompt
signature is degraded empty-response DETECTION (best-effort) — not a total outage that
burns SDK credits and trips the circuit.

## 2. Under-protect (does keeping a "failed" session risk bad output?)

A canary fail means the empty-prompt SIGNATURE couldn't be verified for this lifetime —
the session can still serve real prompts. If a session is GENUINELY broken (can't
respond at all), the canary-fail no longer kills it at startup, but the existing
per-call path handles that: a failed allocate/prompt retires + replaces the session
(`pool:degraded` / retire-on-error), and the recurring canary keeps probing. So a truly
dead session is still caught — just by the per-call machinery, not by refusing everyone.
The degradation is reported (DegradationReporter) so the unverified state is visible.

## 3. Level-of-abstraction fit

Correct. This is a single conditional's failure policy. No LLM, no new dependency. It
aligns the structured-fail policy with the already-existing infra-error policy in the
same method ("missing canary is protection-in-depth, not a primary failure path").

## 4. Blast radius

The interactive pool is opt-in (subscription-path; dark by default, active on this
agent). When the canary passes (the normal case) behavior is unchanged. Only the
fail-at-startup path changed, and only to stop refusing service. `canaryHasRunInCurrentLifetime`
is still set (the structured result returned normally), so the canary isn't re-run every
spawn. No change to the recurring canary, allocation, or retire/replace.

## 5. Rollback

Pure code revert. No state/config/format change.

## 6. Tests

`pool-canary-graceful.test.ts` (new): source guards that the canary-fail branch does NOT
throw, does NOT kill/delete the session, still reports a degradation, and that spawnOne
reaches the ready transition after the canary block. The existing 53 interactive-pool
unit tests pass unchanged; `tsc --noEmit` clean; no-silent-fallbacks budget unaffected
(the change removes a throw, adds no catch).

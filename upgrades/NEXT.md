# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

**Coherence-critical safety checks no longer switch off under rate-limit
pressure.** Every server-side LLM call shares one circuit breaker; when the
account is rate-limited it opens for ~15 min and refuses all calls. Until now,
each guard's fallback was to *fail open* — skip its check and allow the action.
So at exactly the moment the system is busiest, the outbound-message gate, the
stop-authority gate, and the high-stakes coherence reviewers all stopped
guarding (the logs literally showed `Stop event allowed without authority
ruling … fail-open` and `message review failed … fail open`).

Now a small set of coherence-critical guards WAIT (bounded) for the rate-limit
window to clear and then get a real answer — "slower but coherent" — instead of
waving things through. Best-effort/observability checks (the high-volume callers
that trip the breaker) keep failing open so they shed load and let it recover.
The breaker also reads a retry-after hint from the provider error when present
and shortens its window accordingly (falling back to the flat window otherwise —
true HTTP headers are invisible because LLM calls go through a CLI subprocess).

## What to Tell Your User

Nothing to configure. Under heavy rate-limit pressure, a few safety-critical
checks (the outbound-message review, the "is this stop justified" ruling, the
high-stakes coherence reviewers) may now take a little longer instead of being
skipped — so the agent stays coherent and doesn't leak or wave through bad
actions exactly when the system is most loaded. Everything else is unchanged.

## Summary of New Capabilities

- `LlmCircuitBreaker.acquireOrWait(maxWaitMs)` — bounded wait-and-retry that
  serializes waiters behind the single half-open probe (no thundering herd).
- `classifyRateLimit(message)` — superset of `isRateLimitError` that also
  best-effort parses a retry-after hint; the breaker shortens its open window to
  the hint (clamped), else uses the flat default.
- `IntelligenceOptions.rateLimitWaitMs` — opt-in per-callsite policy; set on
  MessagingToneGate (120s), CoherenceGate high-stakes reviewers (60s), and
  UnjustifiedStopGate (8s). Unset = instant fail-open (unchanged).

## Evidence

**Reproduction (live, server.log, 2026-05-31):** LLM circuit breaker tripped 18×
in one day; trips #15–#18 fired 20:34–21:59Z. During those open windows:
`[InputGuard] DEGRADATION: LLM review failed: LLM circuit breaker open … fail-open`,
and `Stop event allowed without authority ruling (drift correction not applied).
Using fail-open → allow`. So coherence-critical guards were being skipped under
exactly the load that should make them most careful.

**Before/after behavior:**
- Before: breaker open → guard's `provider.evaluate()` throws `LlmCircuitOpenError`
  synchronously → guard fails open (skips its check), every time.
- After: a guard that sets `rateLimitWaitMs` awaits `acquireOrWait(maxWaitMs)` —
  it proceeds with a real ruling if the window clears within the bound, and only
  falls back if the bound elapses. A guard that does NOT set it is byte-identical
  to before (instant throw).

**Tests:** `tests/unit/llm-circuit-breaker-wait.test.ts` — 27 tests, injected
fake clock + clock-advancing sleep (deterministic, no real waiting). Covers
classifyRateLimit parsing, per-trip window shortening + clamp, acquireOrWait
(immediate/closes-in-time/deadline-fallback/herd-serialization), and the
provider opt-in (no-policy instant throw with zero sleeps + inner provider never
called; with-policy waits and proceeds; parsed retry-after threaded through).
Affected-suite regression: 191/191 across the 8 touched test files. tsc clean
(0 errors in changed files).

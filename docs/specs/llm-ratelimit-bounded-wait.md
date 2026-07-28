---
title: Coherence-critical LLM guards wait (bounded) for a rate-limit window instead of failing open
slug: llm-ratelimit-bounded-wait
status: approved
review-convergence: 2026-05-31T23:30:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin explicitly
  greenlit this on topic 13481 (2026-05-31): "Yes, please let's proceed in the
  proper robust process to fix all of this correctly," after reviewing the
  grounded design. Flagged here per cross-agent discipline.
---

# Coherence-critical LLM guards wait (bounded) for a rate-limit window

## Problem

Every server-side LLM call flows through one process-global circuit breaker
(`getLlmCircuitBreaker()`). When Anthropic rate-limits the account, the breaker
opens for a flat 15-minute window and refuses ALL calls. Each guard's catch
block then **fails open** — it skips its check and lets the action through.

Observed live (server.log, 2026-05-31): the breaker tripped 18× in one day;
trips #15–#18 fired 20:34–21:59Z. During those windows the logs show
`[InputGuard] DEGRADATION: LLM review failed ... fail-open`, `Stop event allowed
without authority ruling (drift correction not applied). Using fail-open →
allow`. So under exactly the load that should make the system most careful, the
coherence guards stop guarding:

- **MessagingToneGate** (outbound message gate) stops reviewing → leaked CLI
  commands / file paths, context-death-stop framing, and false blockers reach
  the user unreviewed.
- **UnjustifiedStopGate authority** fails open → unjustified stops slip through.
- **CoherenceGate** internal-channel reviewers abstain → checks skipped.

The owner directive: *"It's acceptable for things to take longer if we have to
wait on rate limits, as long as the operation is more robust and more
coherent."* I.e. coherence-critical calls should prefer **wait-and-retry** over
fail-open; best-effort/observability calls may keep failing open to shed load.

## Why the breaker can't see Retry-After

LLM calls shell out to `claude -p` as a subprocess, so the true
`anthropic-ratelimit-*` / `Retry-After` HTTP headers never reach instar — only
the CLI's combined stdout/stderr error text does. Header-accurate timing is
structurally impossible on the subscription/CLI path (the direct-API path is
forbidden). So "honor Retry-After" is best-effort-by-construction: we parse a
duration from the error string when one is present, and fall back to the flat
window otherwise.

## Solution (additive — no behavior change for callers that don't opt in)

1. **`classifyRateLimit(message)`** (`src/core/LlmCircuitBreaker.ts`) — a
   superset of the existing `isRateLimitError` (which is reimplemented as
   `classifyRateLimit(m).isLimit`, so detection is byte-identical). It also
   best-effort parses a retry-after hint (`retry-after: N`, `resets in Ns`, `try
   again in N minutes`, bare `N minutes`), clamped to [1s, 15min], else
   undefined.

2. **Per-trip window** — `onRateLimited(reason, retryAfterMs?)` shortens the
   open window for THIS trip to the parsed hint, clamped to
   `[min(30s, openMs), openMs]`. Without a hint, the flat default window is used
   (unchanged). Reset to the full window on a clean close.

3. **`acquireOrWait(maxWaitMs)`** — the coherence-critical primitive. Loops:
   when open, sleeps just past the window edge; when half-open with another
   caller's probe in flight, polls at `probePollMs`; returns `allow:true` as soon
   as admitted, or `allow:false` at the bounded deadline. Waiters serialize
   behind the single half-open probe — exactly one probe hits the provider, no
   thundering herd. Clock + sleep are injectable for deterministic tests.

4. **`IntelligenceOptions.rateLimitWaitMs`** — when a caller sets it and the
   breaker is open, `CircuitBreakingIntelligenceProvider.evaluate()` awaits
   `acquireOrWait(rateLimitWaitMs)` instead of throwing immediately. When unset,
   behavior is byte-identical to today (instant `LlmCircuitOpenError`). The
   catch path now passes the parsed retry-after through to `onRateLimited`.

5. **Per-callsite policy** — coherence-critical callsites opt in:
   - MessagingToneGate: `rateLimitWaitMs = 120_000` (outbound message can wait up
     to 2 min for a correct, reviewed send).
   - CoherenceGate high-stakes reviewers only (`value-alignment`,
     `claim-provenance`, `capability-accuracy`, `information-leakage`):
     `60_000`.
   - UnjustifiedStopGate: `8_000` — SHORT, because it sits on the agent's Stop
     critical path; a long wait would hang the agent, so it waits briefly then
     falls back to its existing safe behavior.
   - All best-effort/observability callsites omit it → instant fail-open,
     unchanged, so they keep shedding load and let the breaker recover.

## Scope

- `src/core/LlmCircuitBreaker.ts` — classifyRateLimit, per-trip window,
  acquireOrWait, injectable sleep/probePollMs.
- `src/core/CircuitBreakingIntelligenceProvider.ts` — opt-in bounded wait.
- `src/core/types.ts` — `IntelligenceOptions.rateLimitWaitMs`.
- `src/core/MessagingToneGate.ts`, `src/core/UnjustifiedStopGate.ts`,
  `src/core/CoherenceReviewer.ts`, `src/core/CoherenceGate.ts` — opt-in wiring.

## Testing

`tests/unit/llm-circuit-breaker-wait.test.ts` (27 tests, injected fake
clock + clock-advancing sleep, fully deterministic):
- `classifyRateLimit` parsing (retry-after / resets-in-Ns / N-minutes / bare
  429 → isLimit-no-hint / non-limit / absurd-value clamp).
- `onRateLimited(retryAfterMs)` shortens the window + admits a probe exactly at
  the hint, floors to min(30s, openMs), falls back to flat default.
- `acquireOrWait`: closed → immediate (no sleep); open-closes-in-time →
  allow:true; window-longer-than-maxWait → allow:false at deadline; herd → one
  probe admitted, loser polls then proceeds on close, or keeps waiting if the
  probe reopens.
- Provider-level: no `rateLimitWaitMs` → instant throw (byte-identical, zero
  sleeps, inner provider never called); with it → waits and proceeds; shorter
  than window → still throws; parsed retry-after threaded to `onRateLimited`.

All affected suites green (191/191 across the 8 touched test files). tsc clean.

## Non-goals / risks

- Does not change the breaker's spend-protection purpose (the $452-incident
  motivation) — it adds a bounded-wait TIER, it does not weaken the open state.
- A bounded wait never hangs an urgent path: every wait has a hard `maxWaitMs`
  then the caller's existing fallback runs. UnjustifiedStopGate's cap is small by
  design.
- Header-accurate Retry-After is impossible on the CLI path; the flat-window
  fallback is honest about that rather than pretending to have header data.
- Best-effort callers stay instant-fail-open so they don't consume the scarce
  half-open probe slot.

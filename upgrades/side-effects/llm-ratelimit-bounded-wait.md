# Side effects — coherence-critical LLM rate-limit bounded wait

## What changes at runtime

When the shared LLM circuit breaker is open (account rate-limited), a small set
of coherence-critical guards now WAIT (bounded) for the window to clear before
falling back, instead of instantly failing open. Everything else is unchanged.

## Who is affected

- **Callers that do NOT set `rateLimitWaitMs`** (the vast majority — every
  best-effort/observability LLM consumer): **zero behavior change.** When the
  breaker is open they still throw `LlmCircuitOpenError` immediately and run
  their existing fail-open fallback. Proven by a dedicated test (instant throw,
  zero sleeps, inner provider never called).
- **MessagingToneGate** (outbound gate): when rate-limited, waits up to 120s for
  the window, then falls back to its current pass-through. Net effect: under rate
  limit, an outbound message may be delayed up to 2 min to be properly reviewed,
  rather than sent unreviewed.
- **UnjustifiedStopGate**: waits up to 8s (short — it's on the Stop critical
  path), then its existing fail-open behavior. A stop may be delayed up to 8s
  under rate limit.
- **CoherenceGate high-stakes reviewers** (value-alignment, claim-provenance,
  capability-accuracy, information-leakage): wait up to 60s. Other reviewers
  unchanged (instant fail-open).

## Blast radius

- 7 files, all in `src/core/`. No config keys, no new env, no migration (the
  change is compiled source, not an agent-installed file/hook/skill).
- The breaker remains a single process-global singleton; no new global state
  beyond a per-trip window length field.
- `isRateLimitError` detection is byte-identical (reimplemented as
  `classifyRateLimit(m).isLimit`).

## Failure modes considered

- **Latency under rate limit:** bounded by `maxWaitMs` per callsite; the
  Stop-path wait is deliberately small (8s). A wait can never hang indefinitely.
- **Thundering herd on window-close:** `acquireOrWait` re-consults `acquire()`
  so waiters serialize behind the single half-open probe; exactly one call
  probes the provider on recovery.
- **Retry-after parse error:** parsed values are clamped to [1s, 15min]; any
  unparseable/absurd value falls back to the flat 15-min default window.
- **Load shedding preserved:** best-effort high-volume callers keep failing open,
  so they don't consume the scarce probe slot or re-trip the breaker.

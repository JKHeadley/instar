# R4 Finding — claude intermittent rate-limit (handling) + 2026-06-30 event-loop stalls

**Date:** 2026-07-01 · source investigation (src/core/LlmCircuitBreaker.ts, CartographerSweepEngine.ts).

## (A) Claude intermittent rate-limit — the fragile part is RESET-WINDOW PARSING, not detection
- **Detection is robust:** classifyRateLimit() matches 429/402, a broad phrase set (rate limit,
  usage limit, quota, out of credit, spend limit, …), and a bare `quota`. Low false-negative risk.
- **The fragile point:** the reset-after hint is parsed from UNSTRUCTURED CLI error text (the HTTP
  retry-after header is invisible to `claude -p`). If the reset phrase does NOT parse, the breaker
  falls back to `DEFAULT_OPEN_MS` (15 min, = RETRY_AFTER_MAX_MS clamp). A documented live incident
  (2026-06-03, gemini): an "8 second" reset phrased as "reset after 8s" failed to parse → a
  15-minute GLOBAL llm pause = ~100x over-correction. Fixed then by adding the "(in|after)" pattern.
- **Characterization takeaway:** claude's *intermittent rate-limit* pain is amplified by the
  breaker's blunt fallback. Any claude limit whose reset phrasing the parser misses → the pathway
  is paused for the full 15 min even if the real reset was seconds/short. The rate-limit itself is
  a subscription-window event (5h/weekly); the OVER-PAUSE is a handling artifact.
- **Fix directions (R6, reversible):** (1) add a claude-specific reset-phrase test to the parser
  corpus (guard against the next unparsed phrasing); (2) lower the unparsed-fallback from 15 min to
  a shorter probe-and-retry (e.g. 60s then re-test) so an unparsed reset can't wedge the pathway for
  15 min; (3) use the subscription-pool's live quota reading (which HAS structured reset times) to
  set the breaker window instead of parsing stderr, when the account is pool-managed.

## (B) 2026-06-30 event-loop stalls — cartographer sweep (already mitigated)
- The stalls trace to the cartographer freshness sweep doing a whole-tree walk on the server event
  loop. Already fixed (instar#1069, in current source): `CartographerSweepEngine` runs detect +
  index writes in a WORKER THREAD (`detectInWorker` default true, 120s bound + single-flight), and
  every `/cartographer/*` read route serves a CACHED snapshot instead of recomputing live.
- **Characterization takeaway:** this is an infra/event-loop issue, not an LLM-pathway property —
  out of scope for the pathway matrix, but noted so R6's routing recommendations don't misattribute
  a past server stall to a slow pathway. Rollback lever exists (`detectInWorker: false` runs the
  same bounded detect synchronously).

## R4 status: COMPLETE — all four named anomalies documented with root cause + fix directions.

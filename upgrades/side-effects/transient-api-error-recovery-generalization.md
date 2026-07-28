# Side effects — Generalize backoff recovery to the whole transient-API-error class

## What this changes
Extends the intelligent throttle-recovery lifecycle (RateLimitSentinel) to cover ALL transient API errors (500/502/503, overloaded, timeouts, connection drops), not just rate limits — the 2026-05-29 future-proofing ask (topic 13481). Builds on the per-episode nudge re-arm (same branch).

- `src/monitoring/RateLimitSentinel.ts` — new `ApiErrorClass = 'throttle' | 'transient-api'`. `report(name, trigger, { errorClass })` (default 'throttle' → fully back-compatible). Per-class backoff schedule (`transientApiBackoffScheduleMs` = [5s,15s,30s,60s,2m,5m], fast first retry) + per-class user wording in every notice. Lifecycle (backoff→resume→verify→escalate→zombie-veto) unchanged.
- `src/core/SessionManager.ts` — the generic `TERMINAL_ERROR_PATTERNS` idle path now hands off to the sentinel via a new `apiErrorAtIdle` event when a listener is wired (production), mirroring the existing `rateLimitedAtIdle` handoff; the re-armable immediate nudge remains the fallback when no sentinel is wired (bare/test).
- `src/commands/server.ts` — wires `sessionManager.on('apiErrorAtIdle', name => rateLimitSentinel.report(name, 'idle-error', { errorClass: 'transient-api' }))`.

## Why
A generic `API Error: 500` previously only got SessionManager's immediate single nudge — no backoff, no verify, no escalate — while the intelligent RateLimitSentinel was scoped to rate-limit/throttle only. Now a 500 rides the same proven backoff→verify→escalate lifecycle. Spec: docs/specs/SESSION-ERROR-NUDGE-REARM-SPEC.md (Part 2).

## Risk / blast radius
Low + back-compatible. `errorClass` defaults to 'throttle' so all existing rate-limit behavior is byte-identical (14 existing RateLimitSentinel tests unchanged + green). The generic-error handoff only changes behavior when an `apiErrorAtIdle` listener is wired; otherwise the (now re-armable) immediate nudge fallback runs. Future-proof: driven by the existing TERMINAL_ERROR_PATTERNS list. Server-side → deploys fleet-wide via release.

## Tests
- `tests/unit/RateLimitSentinel.test.ts` — +4 transient-api tests (fast 5s first backoff vs 30s throttle; transient-API wording; full lifecycle→recovered; state errorClass + listActive short schedule). Throttle suite unchanged.
- `tests/unit/session-error-nudge.test.ts` — +2: generic-error idle path defers to the sentinel via apiErrorAtIdle when wired; re-armable nudge is the fallback. Plus the Part-1 re-arm + cap behavioral tests.

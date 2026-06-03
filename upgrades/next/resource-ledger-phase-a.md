# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Rate-limit events are now recorded durably (per-agent ResourceLedger, Phase A).**
Until now, every time the account got throttled — a circuit-breaker trip, or a
session hitting Anthropic's server-side rate limit — was counted only in
process-local memory and lost on restart, so "how many times were we throttled
today?" had no answer. This adds a small read-only SQLite ledger
(`server-data/resource-ledger.db`, same pattern as the TokenLedger) that persists
each rate-limit event, fed by a minimal new trip/recover observer on the circuit
breaker plus the existing RateLimitSentinel.

New read-only route `GET /resources/rate-limits?sinceHours=N` returns the durable
count + rate (breaker trips as the headline; session-sentinel detections counted
separately) and recent events. Default-on (event-driven, negligible cost);
`monitoring.resourceLedger.enabled: false` opts out. It never gates or changes any
behavior — the breaker observer is wrapped so a listener error can never affect
the breaker. CPU/memory tracking and a unified `/resources` snapshot are Phase B.

Spec: `docs/specs/per-agent-resource-ledger.md`.

## What to Tell Your User

Nothing to configure. Your agent now keeps a durable record of how often it's
being rate-limited, so that history survives restarts instead of resetting to
zero. You can ask it how many times it was throttled today, or whether the
pressure is getting worse, and it can answer from real recorded numbers.

## Summary of New Capabilities

- New read-only endpoint GET /resources/rate-limits (durable rate-limit-event
  count, rate, and recent events).
- Circuit-breaker trips and session rate-limit detections are now persisted
  across restarts instead of being lost.
- New config flag monitoring.resourceLedger.enabled (default on).

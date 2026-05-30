---
title: UnjustifiedStopGate circuit breaker — stop the CLI-provider timeout churn + /health flood
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Justin's 12-hour autonomous robustness session directive (topic 13435,
  2026-05-30): "increase Instar robustness" and — explicitly — "you should be the
  only truly active session... if you do [see load], be very suspicious because
  this might point to issues in Instar rather than load issues." Investigating the
  persistent `degraded` /health while no other agent was active surfaced exactly
  such a bug: the UnjustifiedStopGate's 2000ms LLM budget is below the ~5-6s
  irreducible `claude -p` latency on subscription agents, so it times out on every
  stop, wastefully spawns+kills a claude subprocess, and floods /health.
eli16-overview: STOPGATE-CLI-CIRCUIT-BREAKER-SPEC.eli16.md
date: 2026-05-30
---

# UnjustifiedStopGate circuit breaker

## Problem

The UnjustifiedStopGate rules on Stop events (catching context-death self-stops)
by making a Haiku judgment call. On subscription agents (no API key) that call
goes through `ClaudeCliIntelligenceProvider`, which spawns a `claude -p`
subprocess — irreducibly ~5-6s to boot + answer. But the gate's client-side hard
budget is `clientTimeoutMs = 2000`. So on every subscription agent:

- **Every** stop event times out (2s < 5-6s) → the gate fail-opens, never ruling.
  The anti-context-death-stop protection is effectively dead on these agents.
- Each timeout still **spawned then killed** a `claude -p` subprocess — wasteful
  churn (the phantom "load" Justin's session surfaced).
- Each fail-open emits a per-event `DegradationReport`, so `/health` accumulates
  one `degraded` entry per stop (observed: 22+ identical entries), making the
  health signal misleading — it reads as a real problem when nothing is wrong.

Verified live: a `claude -p` haiku call in the agent cwd returns in ~5-9s; the
2000ms gate budget can never complete it. With all other agents paused, the
`degraded` state persisted and climbed — a code bug, not load.

## Fix

A self-circuit-breaker on the gate's own LLM path. After `breakerThreshold`
consecutive provider failures (timeout or llmUnavailable), the gate **opens**:
`evaluate()` fails open IMMEDIATELY without spawning a subprocess, for
`breakerCooldownMs`, then retries once (half-open). A reachable provider (any
completed response, even a malformed one — it proves the provider is up) resets
the breaker.

The breaker preserves the exact fail-open behaviour (a `breakerOpen` outcome is
allowed exactly like a `timeout`), so it can never make a stop decision worse. It
only makes the unavoidable fail-open **fast** (no doomed subprocess) and **quiet**
(no per-event degradation, no failure-rollup skew).

### Components

- **`UnjustifiedStopGate`** — new `breakerThreshold` (default 3), `breakerCooldownMs`
  (default 5 min), and an injectable `now` clock (for tests). New `breakerOpen`
  failure kind; `breakerState()` telemetry. `evaluate()` short-circuits when open,
  counts provider failures, resets on a reachable provider.
- **`StopGateDb.InvalidKind`** — gains `breakerOpen`.
- **`/internal/stop-gate/evaluate` route** — fail-opens on `breakerOpen` (as for
  any failure) but skips the failure DB record AND the DegradationReport for it
  (the short-circuit is deliberate, not an evaluation failure).

### Why not just raise the timeout?

Raising `clientTimeoutMs` to ~8s would let the gate complete — but it delays every
Stop by ~6s (the gate runs in the stop path). That interactive cost is a separate
product decision; the breaker fixes the churn + flood + misleading signal without
imposing a stop delay, and leaves `clientTimeoutMs` configurable for operators who
want the gate functional with the delay tradeoff.

## Blast radius

- Stop decisions: unchanged. `breakerOpen` allows the stop exactly like `timeout`.
- Fast-provider (API-key) agents: the breaker never opens (calls succeed), so
  behaviour is identical to today.
- The gate's drift-correction remains a fail-open no-op on subscription agents (as
  it already was) — but now cheaply and quietly. Making it functional there is a
  follow-on with its own tradeoff (tracked in the spec body above).
- No config/schema/migration: the breaker has safe in-code defaults.

## Testing

- **Tier 1 unit** — `UnjustifiedStopGate-breaker.test.ts` (5): opens after K
  failures + stops calling the provider; half-open retry after cooldown; reachable
  provider resets; `breakerThreshold=0` disables; a real timeout also counts.
  Existing gate + route + db suites (42) green.

## Rollback

Revert the commit, or set `breakerThreshold: 0` (disables the breaker; back to the
prior per-event behaviour). No persisted state.

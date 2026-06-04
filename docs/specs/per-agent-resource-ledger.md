---
title: "Per-agent ResourceLedger — every agent durably tracks its own CPU, memory, and rate-limit-event usage"
date: 2026-06-03
author: echo
parent-principle: "Observability — you can't tune what you can't see"
review-convergence: internal-adversarial-plus-integration-2026-06-03
approved: true
approved-by: Justin
approved-via: "Telegram topic 18423 (2026-06-03 — blanket preapproval for the Resource Limitation Mitigation / resource-monitoring workstream: 'You have my preapproval for this work … as you see necessary to get us in a proper responsible resource monitoring and tracking state.' Design converged via adversarial+integration review; read-only observability, never gates.)"
eli16-overview: per-agent-resource-ledger.eli16.md
---

# Per-agent ResourceLedger

## The principle

Every Instar agent is responsible for tracking **all** of its own resource
usage. Today that is partial: tokens are well covered (`TokenLedger`), per-feature
LLM calls now have honest counts + attribution (`FeatureMetricsLedger` + PR #719/#725),
but three resources are tracked **nowhere durably**:

1. **CPU** — zero. Read on demand only (SessionReaper loadavg, etc.); nothing
   accumulates a per-agent CPU history.
2. **Memory** — zero. `MemoryPressureMonitor` reads `process.memoryUsage().rss`
   on demand; no durable RSS/heap series, no leak signal.
3. **Rate-limit events** — **ephemeral**. `LlmCircuitBreaker` counts trips in
   process-local memory (its own header notes "A restart resets it");
   `RateLimitSentinel` emits transient events. All lost on restart, so "how many
   times was the account throttled today" is unanswerable.

This spec adds a per-agent **ResourceLedger**: durable, read-only resource
observability, mirroring `TokenLedger`'s proven pattern (SQLite via
`NativeModuleHealer`, WAL, `registerSqliteHandle` close, idempotent). It **never
gates, throttles, or mutates** any flow. Mitigation (load-shedding,
provider-offload) is a **separate later workstream** that consumes this ledger —
explicitly out of scope here.

## Convergence note (2026-06-03)

This design was revised after an adversarial + integration review that corrected
several factual errors in the first draft. The corrections are now baked into the
Design below; recorded here for traceability:
- The funnel has **no `shed` event** on `main` (PR #719 adds the `shed` outcome to
  the *metrics recorder*, not an event bus) and `LlmCircuitBreaker` is **not** an
  EventEmitter — so "subscribe to shed/trip events" was fictional. Capture is now
  via a **small `trip`/`recover` EventEmitter added to `LlmCircuitBreaker`** (the
  only honest, read-only, per-event source).
- `ps` sampling is **blocking** by codebase precedent (`spawnSync`) — the spec now
  mandates async, bounded, non-blocking sampling.
- `resource_samples` is the first true high-frequency time-series ledger and
  **needs retention** (TokenLedger doesn't, because it's source-offset-bounded).
- Config defaults belong in **`src/config/ConfigDefaults.ts` SHARED_DEFAULTS**, not
  a hand-written `migrateConfig()` block.

## Design

### Capture mechanism (corrected — this is the crux)

One canonical source **per `kind`**, so `rate_limit_events` counts are interpretable:
- **`circuit-open` / `circuit-recover`** — add a minimal `EventEmitter` to
  `LlmCircuitBreaker`: `emit('trip', {reason, retryAfterMs, ts})` in
  `onRateLimited()` and `emit('recover', {ts})` when it closes. This is a tiny,
  additive change to the breaker (NOT the hot `evaluate()` path) and is the only
  per-event, restart-safe source. The poller subscribes and writes one
  `rate_limit_events` row per emission. **This is the primary rate-limit signal.**
- **`throttle` / `quota` / `529` (secondary, session-scoped)** — subscribe to the
  existing `RateLimitSentinel` events (`rate-limit:detected/recovered`, it already
  `extends EventEmitter`). These are *session-recovery* signals (a tmux session
  hit a limit), semantically distinct from breaker trips — recorded with a
  distinct `source='session-sentinel'` so they are never silently summed with
  breaker trips. `rateLimitSummary` reports breaker-trip count as the headline and
  sentinel detections separately.
- **No funnel/hot-path edit.** The `evaluate()` path is untouched.

### Module: `src/monitoring/ResourceLedger.ts`
SQLite store (TokenLedger open/heal/WAL + `registerSqliteHandle` pattern, schema
loop swallowing `duplicate column name`). **All writes swallow errors** (like
`FeatureMetricsLedger.record`) so observability can never break the observed path.
Tables:
- `resource_samples(id, ts, kind, process_label, pid, cpu_user_us, cpu_system_us,
  wall_us, cpu_percent, rss_bytes, heap_used_bytes)` — one row per cadence sample.
  Stores **raw cumulative cpuUsage counters AND wall_us** so the percent is
  reproducible and a missed tick can't corrupt the series; `cpu_percent` is the
  derived delta `(Δcpu / Δwall / cores) * 100`, **null on the first sample**.
  Indexed on `ts`.
- `rate_limit_events(id PK, ts, kind, source, account_key, session_name, reason,
  detail)` — durable event rows. `id` is a real per-event identity (emitter ts +
  monotonic seq + source), NOT a time+detail content hash, so legitimate
  same-ms events don't collapse and a restart can't replay-double-count.
  `account_key` is a reserved constant placeholder today (no per-key source
  exists yet); column reserved for the future fleet roll-up.

Methods (read-only): `recordSample()`, `recordRateLimitEvent()`,
`cpuMemSummary(nowMs, windowMs)`, `rateLimitSummary(nowMs, windowMs)` (breaker-trip
count + events/hour, sentinel detections separately), `rateLimitByKind()`,
`rateLimitEvents({sinceMs, limit})`, and `pruneSamplesOlderThan(cutoffMs)`.
LLM-call rate is **derived** from `TokenLedger`/`FeatureMetricsLedger` at the route
layer — never duplicated here.

### Module: `src/monitoring/ResourceLedgerPoller.ts`
Background worker (default 60s cadence), gated on `monitoring.resourceLedger.enabled`:
1. Subscribes to the breaker `trip`/`recover` emitter + `RateLimitSentinel` events;
   writes `rate_limit_events` per emission (event-driven, not polled).
2. CPU/mem: samples self via `process.cpuUsage()`/`memoryUsage()` (cheap, in-proc)
   and the child tree via **async `child_process.spawn`** of a single `ps` listing
   the whole tree (one spawn per tick, hard-capped PID set, bounded timeout; on
   timeout it skips the sample and never throws). NEVER `spawnSync` — must not
   block the event loop (the box this observes is by definition loaded).
3. Prunes `resource_samples` older than `retentionDays` (default 14) once per N
   ticks — the only delete path; `rate_limit_events` is naturally bounded
   (~hundreds/day) and is not pruned.

### Routes (`src/server/routes.ts`, Bearer-auth, read-only; nullable `ctx.resourceLedger`)
- `GET /resources/rate-limits?sinceHours=N` — event history + per-kind counts.
- `GET /resources` — unified snapshot: latest CPU%/RSS/heap, rate-limit count +
  events/hour, LLM-call rate (from the token/feature ledgers).
- 503 when `ctx.resourceLedger` is null **OR** `monitoring.resourceLedger.enabled`
  is false (explicit config check in the handler).

### Dashboard
A "Resources" tab (plain-language headline + live numbers + recent rate-limit
events) is part of Phase B (see the Phasing section below).

## Phasing (each a small gated PR)
- **Phase A:** breaker `trip`/`recover` emitter + `ResourceLedger` +
  `rate_limit_events` + poller event subscriptions + `GET /resources/rate-limits`
  + 3-tier tests. Closes the ephemeral-rate-limit gap (the acute pain).
- **Phase B:** CPU/mem async sampling + retention + `GET /resources` snapshot +
  dashboard tab.
- **Phase C (separate workstream):** mitigation levers consuming the ledger.

## Standards compliance
- **Read-only** — never gates/throttles/mutates; all writes swallow errors.
- **Wiring (corrected):** construct in `AgentServer` inside `if (config.stateDir)`,
  DB at `path.join(stateDir, 'server-data', 'resource-ledger.db')`, in its **OWN
  try/catch** (NOT chained into TokenLedger's — per the documented cascade-503
  incident), `registerSqliteHandle` close, field `null` on failure. The poller's
  `RateLimitSentinel` subscription is wired in `commands/server.ts` (where the
  sentinel is built), not `AgentServer`. Poller is not started when
  `enabled === false`.
- **Testing Integrity** — 3 tiers: unit (store dedupe + rate math + delta CPU math
  + retention prune + sampling), integration (routes return data / 503 when
  off/null), e2e ("feature is alive" → `/resources/rate-limits` 200 not 503).
  Wiring-integrity: poller's ledger dep non-null/non-noop; a real emitted breaker
  trip lands a row.
- **Migration Parity** — add `monitoring.resourceLedger` to `ConfigDefaults.ts`
  `SHARED_DEFAULTS` (covers init + migration); CPU/mem promotable flag, if
  dark-then-promote, stays a runtime literal in `commands/server.ts` (ConfigDefaults
  is add-missing-only and can't flip a persisted default later); CLAUDE.md template
  (`src/scaffold/templates.ts`) `/resources` entry + `migrateClaudeMd()`
  content-sniff for existing agents.
- **Graduated rollout** — Phase A rate-limit capture ships ON (event-driven,
  negligible cost, no `ps`); Phase B CPU/mem sampling behind a flag (it does the
  `ps` tree-walk).

## Non-goals
- No mitigation/gating (separate workstream).
- No fleet-aggregate roll-up yet (`account_key` reserved).
- No new runtime dependency.

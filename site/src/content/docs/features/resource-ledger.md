---
title: Resource ledger (CPU + memory)
description: Per-agent CPU and memory observability — continuous sampling of an Instar agent's server process and its spawned sessions, mirroring the TokenLedger.
---

Instar agents keep hitting resource ceilings — CPU, memory, and rate limits. Token
usage has long been well-tracked (the [TokenLedger](/features/observability/)), but
until now Instar tracked **zero CPU and zero memory** per agent: there was no
accounting of what an agent's server plus its spawned sessions actually consume.
The per-agent **resource ledger** closes that gap. It measures CPU and memory
continuously, per agent, so usage can be audited, analysed, and — in later slices —
mitigated.

It is read-only observability, built to the same discipline as the TokenLedger: a
SQLite-backed ledger fed by a background poller, exposed over HTTP, that **never
gates, throttles, or mutates** any runtime flow, and that fails open (a sampling
error never crashes the agent).

## Components

- **`ResourceLedger`** — the durable SQLite store (`resource-ledger.db` under the
  agent's `server-data/` directory). It holds two kinds of signal:
  - **Phase A — rate-limit events**: every circuit-breaker trip and session-sentinel
    detection, so "how many times were we throttled today?" survives a restart.
  - **Phase B — CPU/memory samples**: a `resource_samples` table with one row per
    source per sampling tick, bounded by a retention prune (`pruneOlderThan`). The
    ledger exposes `record` / `recordSamples`, `summary`, `recentSamples`,
    `sampleCount`, and `pruneOlderThan`. Every write swallows its own error so
    observability can never break the path it observes.
- **`ResourceSampler`** — the Phase B background poller (mirrors `TokenLedgerPoller`).
  On a cadence it samples:
  - the agent's **own server process** — CPU% computed from a `process.cpuUsage()`
    delta over the tick interval (one busy core reads ~100%), and RSS + V8
    `heapUsed` from `process.memoryUsage()`;
  - each **spawned session** — by its tracked tmux pane PID, via a single batched
    `ps -o pid=,%cpu=,rss= -p <pid>,<pid>,…` call (so the resource tracker is itself
    cheap — one child process per tick, never a per-PID fork storm), tolerating dead
    PIDs (an absent PID is simply skipped);
  - a computed **aggregate** (server + all sessions).

  Its timer is `unref()`'d (it never keeps the process alive), self-reschedules, and
  backs off to an idle cadence when no sessions are running (Responsible Resource
  Usage). `ResourceLedgerPoller` remains the event-driven feeder for the Phase A
  rate-limit events.

## HTTP routes

All routes are Bearer-authed and read-only; each returns `503` when the ledger is
unavailable (disabled or not initialized).

- `GET /resources/summary?sinceHours=N` — current (latest sample) plus windowed
  average and peak CPU% and RSS, broken down per source (`agent-server`,
  `session:<id>`, `aggregate`), plus the total `sampleCount`.
- `GET /resources/samples?sinceHours=N&source=X&limit=N` — recent raw samples,
  newest first, paginated.
- `GET /resources/rate-limits?sinceHours=N` — the Phase A durable rate-limit-event
  count and rate (breaker trips as the headline; session-sentinel detections
  counted separately).

## Dashboard

The dashboard **Resource Usage** tab renders all of this in calm, plain language: a
"right now" headline for the aggregate (CPU% and memory), a per-process breakdown
(server versus each session), and a recent trend. It is XSS-safe (every interpolated
value is escaped) and shows a friendly "not turned on yet" message when the feature
is off for that agent.

## Configuration

The sampler rides the `developmentAgent` dark-feature gate — it is **live on
development agents and dark on the fleet** until promoted, so the slice dogfoods
before fleet rollout. Tune it under `.instar/config.json` →
`monitoring.resourceLedger`:

- `enabled` — master switch (the Phase A rate-limit ledger is default-on; setting
  this `false` disables the whole ledger and the routes 503).
- `sampleIntervalMs` — active sampling cadence (default `60000`).
- `idleSampleIntervalMs` — cadence while no sessions are running (default 5 minutes).
- `retentionDays` — how long CPU/memory samples are kept before the prune (default
  `7`).

## Why it's cheap

A resource tracker must not become a resource hog. The sampler is bounded by
design: its own CPU reading is a free `process.cpuUsage()` delta; all session PIDs
are measured in **one** batched `ps` call per tick (not one per PID); the
`resource_samples` table is bounded by the retention prune that runs each tick; and
the cadence backs off while the agent is idle. Spec:
`docs/specs/per-agent-resource-ledger.md`.

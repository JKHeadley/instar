<!-- bump: minor -->

## What Changed

The per-agent **ResourceLedger** gains **Phase B: continuous CPU + memory
sampling**, closing the gap where Instar tracked token usage well (the
`TokenLedger`) but tracked *zero* CPU and *zero* memory per agent.

A new `ResourceSampler` (mirroring `TokenLedgerPoller`) runs on a cadence and
samples:
- the agent's **own server process** — CPU% from a `process.cpuUsage()` delta over
  the tick interval, plus RSS and V8 `heapUsed` from `process.memoryUsage()`;
- each **spawned session** — by its tmux pane PID, via a single batched
  `ps -o pid=,%cpu=,rss= -p …` call (one child process per tick, dead-PID tolerant);
- a computed **aggregate** (server + all sessions).

Each reading is written to the existing `ResourceLedger` SQLite store (a new
`resource_samples` table, bounded by a retention prune). Two read-only routes
expose it — `GET /resources/summary` (current + windowed avg/peak CPU%/RSS per
source) and `GET /resources/samples` (recent raw samples) — alongside a new
dashboard **Resource Usage** tab that renders it in plain language.

The sampler rides the `developmentAgent` dark-feature gate: it is **live on
development agents and dark on the fleet** until promoted. Configuration lives
under `monitoring.resourceLedger` (`sampleIntervalMs`, `idleSampleIntervalMs`,
`retentionDays`). It is read-only observability — it never gates, throttles, or
mutates anything, and it fails open (a sampling error never crashes the agent).
It is also cheap by design: a free CPU-usage delta, one batched `ps` per tick,
bounded retention, and an idle-cadence backoff when no sessions are running.

## What to Tell Your User

I can now show you how much CPU and memory I'm actually using — my own server
process and each session I have running — sampled continuously. Just ask "how
much CPU or memory am I using right now?" and I'll give you the current numbers
plus the recent peaks, or open the new Resource Usage tab on the dashboard to see
it laid out: a right-now headline, a breakdown by process, and a recent trend.

This is purely a window into resource use — it watches and reports, it never
changes how I work or slows anything down. On most agents it ships turned off for
now while it proves itself; if you'd like it switched on, just say so.

## Summary of New Capabilities

- See current and recent CPU and memory use per agent, broken down by the server
  and each running session, plus a combined total.
- New read-only endpoints: GET /resources/summary and GET /resources/samples.
- New dashboard Resource Usage tab.
- Tunable cadence and retention; ships live on development agents, dark on the fleet.

## Evidence

- New unit tests (`tests/unit/ResourceLedger.test.ts` Phase B block,
  `tests/unit/ResourceSampler.test.ts`): record/summary/recentSamples/prune/count,
  CPU% from a `cpuUsage` delta, batched-PID sampling, dead-PID tolerance, aggregate,
  idle backoff, and fail-open-never-throws — 22 passing.
- Wiring-integrity (`tests/unit/resource-sampler-wiring.test.ts`): the sampler is
  constructed behind the `developmentAgent` gate, stopped on shutdown, delegates to
  the real ledger (not a no-op), and is read-only / off the hot path — 8 passing.
- Integration (`tests/integration/resources-summary-routes.test.ts`):
  `/resources/summary` + `/resources/samples` return 401 without a bearer token,
  503 when disabled, and 200 with per-source data; no raw event bodies leak —
  5 passing.
- E2E (`tests/e2e/resources-summary-lifecycle.test.ts`): on the production
  `AgentServer` boot path the route is alive (200 under `developmentAgent`) and
  503-stubs when the ledger is disabled — 5 passing.
- `npm run build`, `npm run lint`, `node scripts/docs-coverage.mjs --check`, and the
  parity guards (feature-delivery-completeness, capabilities-discoverability,
  builtin-manifest, ConfigDefaults) all green.

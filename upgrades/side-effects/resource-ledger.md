# Side-Effects Review — ResourceLedger Phase B (CPU + memory sampling)

**Version / slug:** `resource-ledger`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Add continuous CPU + memory sampling to the per-agent `ResourceLedger`. A new
`ResourceSampler` (mirroring `TokenLedgerPoller`) samples the agent's own server
process (CPU% via a `process.cpuUsage()` delta, RSS + heapUsed via
`process.memoryUsage()`) and each spawned session by its pane PID (one batched `ps`
call, dead-PID tolerant), plus an aggregate, into a new `resource_samples` table.
Two read-only routes (`/resources/summary`, `/resources/samples`) and a dashboard
"Resource Usage" tab expose it. Constructed at boot in `AgentServer` behind the
`developmentAgent` dark-feature gate; bounded by a retention prune.

## Decision-point inventory

One gate: whether to construct + start the sampler. It resolves
`monitoring.resourceLedger.enabled ?? !!config.developmentAgent` — explicit config
wins; otherwise live on dev agents, dark on the fleet. No other decision logic; the
sampler is pure observation (no kill/throttle/route-block verdicts).

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing is rejected. The sampler
gates nothing — it only reads `ps`/`process.*` and writes the ledger. The routes
return data or a `503` stub when the ledger is null; they never block a caller.

## 2. Under-block

**What does this still miss?** CPU% for sessions comes from the pane PID's `ps
%cpu`, which on macOS/Linux is a lifetime-average for the process, not a precise
instantaneous interval rate (the own-process reading IS a true interval delta). It
samples the pane shell PID, not a full descendant-tree roll-up, so a session's
total tree CPU is approximated by the pane process line `ps` returns. Rate-limit
aggregation across the fleet and mitigation actions are explicitly later slices —
this slice only measures.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The sampler lives in `monitoring/` beside `TokenLedgerPoller`
and writes the existing `ResourceLedger`; boot wiring lives in `AgentServer`
alongside the Phase-A ledger construction; the routes are inline in `routes.ts` next
to `/resources/rate-limits` and `/tokens/*`. The pane-PID resolver is a read-only
method on `SessionManager` (the owner of session/tmux truth), reusing the same
`tmux list-panes #{pane_pid}` pattern already there.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. The ledger and sampler are pure signal: every write
swallows its own error, every OS call is guarded, and a sampling failure records
nothing and retries next tick (`@silent-fallback-ok`). The sampler never reaches
back into any runtime flow — it cannot affect the `LlmCircuitBreaker`, the reaper,
sessions, or messaging.

## 5. Interactions

Reads `SessionManager.getRunningSessionPanePids()` (new, read-only) once per tick;
no mutation of session state. Shares the `ResourceLedger` SQLite handle with the
Phase-A rate-limit path (same DB, separate `resource_samples` table — no schema
collision; the rate-limit methods are untouched). The `ps` call is a child process,
isolated from the event loop. No interaction with the SessionReaper, sentinels,
compaction recovery, or the multi-machine lease. Idempotent boot (additive table
DDL), clean shutdown (sampler stopped before the ledger closes).

## 6. External surfaces

Two new HTTP routes (`GET /resources/summary`, `GET /resources/samples`,
Bearer-authed, read-only), registered in `CapabilityIndex`. One new dashboard tab
(static HTML/JS, XSS-safe via escaping, friendly "not turned on" state on 503). New
config block `monitoring.resourceLedger.{sampleIntervalMs,idleSampleIntervalMs,
retentionDays}` with `applyDefaults` backfill. CLAUDE.md template + idempotent
`migrateClaudeMd` backfill so existing agents learn the capability. No new
notifications, no Telegram, no external network calls. One new SQLite table inside
the already-present `resource-ledger.db`.

## 7. Performance (a resource tracker must itself be cheap)

This is the dimension that matters most here — the tracker must not become a
resource hog.

- **Sampling cost per tick is bounded and small.** The own-process reading is a free
  `process.cpuUsage()` + `process.memoryUsage()` pair (no syscall fork). All session
  PIDs are measured in **one** batched `ps` child process per tick — never one fork
  per PID — with a 5s timeout and a 1 MB output cap. Default cadence is 60s
  (active), backing off to 5 minutes when no sessions are running, so the idle CPU
  floor is barely moved.
- **Write cost is bounded.** Each tick writes a handful of rows (server + N sessions
  + 1 aggregate) in a single transaction. No JSONL scan, no file walk (unlike the
  TokenLedger), so there is no large-history boot hazard.
- **Storage is bounded.** The `resource_samples` table is pruned every tick to a
  retention window (default 7 days). At a 60s cadence with a few sessions that is on
  the order of tens of thousands of small rows — kilobytes-to-low-megabytes, indexed
  on `(ts)` and `(source, ts)` for cheap windowed queries.
- **Fail-open never amplifies cost.** A slow/failed `ps` is caught (no stacking — a
  re-entrant tick is skipped), and the timer is `unref()`'d so it can't keep the
  process alive. The feature ships dark on the fleet (developmentAgent gate), so the
  fleet-wide cost is zero until each agent is deliberately promoted.

## Rollback

Set `monitoring.resourceLedger.enabled` to `false` (disables the whole ledger; the
routes 503) — or, to keep Phase A but stop sampling, the sampler simply is not
constructed when the `developmentAgent` gate resolves off. No data migration to
reverse; the `resource_samples` table is additive and inert when unused.

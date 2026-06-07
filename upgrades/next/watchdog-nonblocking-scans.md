<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

`SessionWatchdog` polled every 30s over every running session, running several
`ps`/`pgrep` probes per session via synchronous `spawnSync` — each blocking the single
Node event loop for its full duration. Under load (dozens of sessions on a busy box) the
cumulative stall made the server miss its own `/health` window, so the supervisor
declared it down and restarted it in a loop (2026-06-07 "server temporarily down on
every message" incident, topic 21816). The watchdog's process scans are now async
(`execFile`) and the poll yields the event loop between sessions, so health checks stay
responsive while scans run. The watchdog's escalation/kill DECISIONS are unchanged —
only the I/O mechanism of its read-only probes changed.

## What to Tell Your User

If they saw "server temporarily down" on nearly every message during a busy period,
with the server restarting repeatedly: a big contributor was the watchdog freezing the
event loop while scanning processes. It no longer does. Nothing for them to do.

## Summary of New Capabilities

- `SessionWatchdog` process scans (`getFrameworkPid`/`getClaudePid`/`getChildProcesses`/
  `hasActivePipelineSibling`/`checkCompactionIdle`) are async (`execFile`) instead of
  blocking `spawnSync`.
- `poll()` yields the event loop (`setImmediate`) between sessions so a scan over many
  sessions can't monopolize the loop and starve `/health`.

## Scope (honest)

Contained Tier-1 refactor of one monitor (`src/monitoring/SessionWatchdog.ts`) + its
tests. Behavior-equivalent (same commands, parsing, thresholds, LLM gate); only the
sync→async I/O mechanism changed. The watchdog stays opt-in. The same blocking-scan
pattern exists in OrphanProcessReaper / mcpProcessReaper (lower cadence — memory-pressure
and 30-min triggers); those are a candidate follow-up, not in this PR.

## Evidence

`tests/unit/SessionWatchdog-nonblocking.test.ts`: scanning helpers return Promises; a
0ms timer fires during an in-flight probe (loop stays live); source guards assert no
`spawnSync(` call, `execFileAsync` present, the three helpers async, and `poll()` yields
via `setImmediate`. Existing compaction/pipeline/mcp/rate-limit watchdog suites updated
to `await` and pass. 72 watchdog unit tests green; `tsc --noEmit` clean. causalAutopsy:
latent — synchronous process scans were always event-loop-blocking, but only surfaced as
a health-miss restart loop once session count × machine load grew large enough.

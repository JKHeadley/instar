# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`StateManager.listSessions()` now serves from a short-TTL in-memory cache instead
of re-reading and re-parsing every session file from disk on every call.

**The bug (a systemic CPU hot-loop).** `listSessions()` did `readdirSync` +
`readFileSync` + `JSON.parse` of **every** session JSON file on **every** call —
and it's called each tick by the SessionReaper and the sentinels via
`listRunningSessions()`. So the cost was O(sessions × pollers × tick-rate) disk
reads, which kept agent servers spinning at 50–67% CPU (a CDP profile showed ~30%
of server CPU was literally `readFileUtf8`, with `listSessions` on top). It was
systemic (every agent with sessions + active pollers) and survived restarts —
which is exactly why bouncing a hot server never helped.

**The fix.** A 1-second TTL cache on the full session list. The many sub-second
read-only callers within a tick now share one disk read; the cache is invalidated
on every session write (`saveSession` / `removeSession`), so a freshly spawned or
terminated session is visible on the very next call — no staleness for the cases
that matter. `listSessions` returns shallow copies, so a caller can't corrupt the
shared cache. StateManager is the sole in-process writer of session files, so the
invalidation is complete (cross-machine writes carry at most the 1s TTL of
staleness, which the reaper/scheduler already tolerate).

Net effect: the per-tick session-directory churn collapses to near-zero, fixing
the agent-server CPU hot-loop fleet-wide with no behavior change.

## What to Tell Your User

Nothing required — it's an internal performance fix. If your agent's server was
running hot / the machine load was high with no obvious cause, this is a likely
culprit and it's now fixed; servers idle much cooler.

## Summary of New Capabilities

- None (no new API, route, or config). `StateManager.listSessions()` is now cached
  (1s TTL, write-invalidated); behavior is unchanged, cost drops from O(files) per
  call to one read per second of read-only traffic.

## Evidence

- Pinned with node's inspector: SIGUSR1 → CDP CPU profile of a hot agent server
  showed 30.8% `readFileUtf8` + 7% `listSessions` (StateManager.js:151), called via
  the reaper/sentinel ticks — the symbolicated JS frame macOS `sample` couldn't show.
- Tests: `tests/unit/state-manager-listsessions-cache.test.ts` — 6 tests (cache HIT
  within TTL; MISS after TTL; immediate invalidation on saveSession + removeSession;
  status-filter on cached data; copy-safety; corrupt-file skip). The 71 existing
  StateManager tests + 255 consumer tests (reaper, scheduler, restart-all, recovery)
  stay green.

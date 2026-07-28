# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**The SleepWakeDetector no longer mistakes CPU starvation for machine sleep — the "my agent keeps restarting / it's overloaded" storm is fixed.**

The detector spots real OS sleep by watching timer drift: a 2-second heartbeat
that fires much later than expected means the process was suspended. But timer
drift has **two** causes, and the detector treated both as sleep:

1. **Real sleep** — the OS suspends the process; the wall clock jumps forward.
2. **CPU starvation** — on an oversubscribed box (many concurrent agent sessions,
   load ≫ cores) the event loop is so backed up it can't service the 2s timer on
   time, so the callback fires seconds late. Nothing actually slept.

On a heavily-loaded machine the second case fired constantly — in one real
incident, **466 false "wake after ~8–29s sleep" events in a single server log**.
Each false wake ran expensive recovery (Cloudflare tunnel force-restart that then
timed out, re-registration, the lifeline `ServerSupervisor` resetting its
failure counters), which piled *more* load onto the box — a self-reinforcing
storm the user experienced as the agent endlessly "restarting due to overload"
even though memory was completely fine.

The detector now **classifies** drift instead of blindly trusting it:

- **Short drift under heavy CPU load** (`loadavg[0] / cpuCount > maxLoadRatio`,
  default `1.5`) is treated as event-loop starvation and **suppressed** — no wake
  event, so none of the expensive recovery fires.
- **A long drift** (`>= longSleepFloorSeconds`, default `300`) is *always* honored
  as real sleep — a live event loop never starves for minutes (a watchdog would
  declare the process dead first).
- **A short drift under normal load** is a genuine brief sleep — emitted as before.
- An **emit cooldown** (`minWakeIntervalMs`, default `60000`) caps how often wake
  recovery can fire, so even a misclassified burst can't storm; long sleeps bypass
  it. On Windows (`os.loadavg()` returns `[0,0,0]`) the load guard self-disables,
  preserving prior behavior.

Suppressed starvation drifts are deliberately kept *out* of the wake history, so
`getCumulativeSleepMsBetween` (the wake-reaper's sleep-credit source) never counts
starvation as if a job had slept through it.

The thresholds live as defaults in the detector class, so **both** consumers — the
server's wake-recovery handler and the lifeline's `ServerSupervisor` (which shares
the class) — get the fix on update with no config migration. A new read-only
route **`GET /monitoring/sleep-wake`** reports `wakeCount` (genuine sleep/wake) vs.
`suppressedCount` with a `cpu-starvation` / `cooldown` breakdown — the visibility
that was missing while the storm was happening.

## What to Tell Your User

If I've been telling you I keep "restarting because too many sessions are
overloading the system," that message was half-right and half-misleading: the
machine really was overloaded, but on **CPU**, not memory — so checking RAM
looked fine and the warning seemed wrong. The cause was too many things running at
once (lots of concurrent sessions / agents), which starved my internal timers and
made me *think* the computer had gone to sleep and woken up — over and over,
hundreds of times an hour. Each false "wake" kicked off heavy recovery work
(restarting my tunnel, re-registering) that just added more load.

I can now tell the difference between the machine actually sleeping and the
machine just being too busy, so I stop overreacting to a busy moment. When things
are genuinely overloaded I now ride it out quietly instead of thrashing. If you
want to see it, ask me — I can show you how many real wakes vs. false ones I've
absorbed, and I'll point you at the load average (not RAM) as the thing to watch.

The real-world remedy when that number is high is still fewer things running at
once or a less-loaded machine — but the agent will no longer make a busy box worse
by storming itself.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| CPU-starvation guard on sleep detection | Automatic. Short timer drift under high CPU load (`loadavg[0]/cpuCount > 1.5`) is classified as starvation and suppressed instead of triggering wake-recovery; long drift is always treated as real sleep. Fixes both the server's wake handler and the lifeline `ServerSupervisor`. |
| Sleep/wake telemetry route | `curl -H "Authorization: Bearer $AUTH" http://localhost:4040/monitoring/sleep-wake` → `{ wakeCount, totalSleepSeconds, longestSleepSeconds, suppressedCount, suppressedByReason: { 'cpu-starvation', cooldown }, lastSuppressedAt }`. `?sinceMs=<epoch>` windows it. |
| Tunable thresholds | Optional `.instar/config.json` → `{"monitoring": {"sleepWake": {"maxLoadRatio": 1.5, "longSleepFloorSeconds": 300, "minWakeIntervalMs": 60000}}}`. Defaults live in code, so the guard is active with no config. |

## Evidence

- Unit: `tests/unit/sleep-wake-starvation-guard.test.ts` — classification boundary
  (short-drift-high-load suppressed / short-drift-normal-load emitted /
  long-drift-always-emitted), emit cooldown (suppress within window, long-sleep
  bypass, re-emit after elapse), Windows `loadavg=[0,0,0]` self-disable,
  `maxLoadRatio: Infinity` opt-out, and the cumulative-sleep exclusion of
  suppressed drifts. Existing detector tests updated to inject idle load so they
  test the drift mechanism independent of the host's real load.
- Integration: `tests/integration/sleep-wake-routes.test.ts` — `GET
  /monitoring/sleep-wake` returns 503 when unwired, 200 with the full wake +
  suppression telemetry through the HTTP pipeline, and honors `?sinceMs` filtering.
- E2E: `tests/e2e/sleep-wake-telemetry-lifecycle.test.ts` — boots the real
  `AgentServer`, asserts the route is alive (200, not 503) + telemetry surfaces +
  Bearer auth, plus a wiring-integrity guard that `server.ts` actually passes the
  detector into `AgentServer` (anti-shipped-but-asleep).

# Upgrade Guide — SleepWakeDetector stops false-firing on a moderately-loaded host

<!-- bump: patch -->

## What Changed

A short timer drift that recurs while load sits in the **1.0–1.5/core band** slipped past both
existing guards: the load guard fires only above 1.5/core, and the consecutive burst floor resets
whenever on-time ticks fall between drifts. Its ~2-minute cadence also outlasted the 60s cooldown.
So each isolated drift emitted a **false `wake`**, firing the full wake-recovery cascade (tunnel
restart, Slack reconnect, mesh-lease churn, topic failover) — the source of a class of multi-machine
UX failures: a reply that's lost the conversation thread, messages that get no reply, and "remote
typing is disabled" (the 2026-06-15 incident, measured at ~1.13/core).

The detector now adds a **recurring-drift guard**: a short drift within `recentDriftWindowMs`
(default 5 min) of a prior short drift, while load is oversubscribed (`> recentDriftLoadFloor`,
default 1.0/core), is treated as recurring CPU starvation and suppressed. This generalizes the burst
floor from *consecutive* ticks to *recent* ticks, and the load gate confines it to the
oversubscribed band the hard guard leaves open.

## What to Tell Your User

- **Fewer spurious reconnects on a busy laptop**: "When my machine got busy I used to mistake the
  slowdown for the computer going to sleep, which kicked off a disruptive recovery — dropping the
  conversation thread, going quiet, or disabling typing. I now recognize that pattern and stay calm,
  so those multi-machine glitches should largely stop."
- **Real sleeps still handled**: "If the machine genuinely sleeps, I still notice and recover
  properly — nothing changes there."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Suppress false "wake" events from CPU starvation on a loaded host | automatic |
| Tune or disable the new guard | `monitoring.sleepWake.recentDriftWindowMs` / `.recentDriftLoadFloor` (set window to 0 to disable) |

## Evidence

Reproduction (live, 2026-06-15): on a host measured at loadavg ~18 on 16 cores (~1.13/core — above
1.0 but below the 1.5 hard guard), `server.log` showed `[SleepWakeDetector] Wake detected after
~33s/~21s sleep` recurring roughly every 2 minutes while the host was actively in use (not sleeping),
each triggering the wake-recovery cascade. The drifts were isolated (on-time ticks between them reset
the consecutive counter) and ~2 min apart (outlasting the 60s cooldown), so neither existing guard
caught them.

After the fix (verified by 45/45 sleep-wake unit tests across 5 files, both sides of the boundary): a
recurring short drift in the 1.0–1.5 band is suppressed (no `wake` emitted, recorded as
`cpu-starvation`); a genuinely isolated short drift, any drift on a light/idle host (ratio ≤ 1.0),
and every long (real) sleep still emit; `recentDriftWindowMs: 0` restores byte-identical prior
behavior. tsc clean.

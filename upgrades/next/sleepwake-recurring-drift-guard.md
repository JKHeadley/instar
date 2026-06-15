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

## Impact

- No change on a light/idle host (ratio ≤ 1.0): repeated short drifts still emit.
- No change for a genuinely isolated short drift, or any long (real) sleep — both still emit and
  recover normally.
- Tunable via `monitoring.sleepWake.recentDriftWindowMs` / `.recentDriftLoadFloor`. Set
  `recentDriftWindowMs: 0` to disable (exact rollback to prior behavior). No migration —
  the fix ships in the class default, so every agent gets it on update.

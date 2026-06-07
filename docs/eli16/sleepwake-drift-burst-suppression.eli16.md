# SleepWake drift-burst suppression — ELI16

> The one-line version: the server kept "restarting its tunnel" every couple minutes because a detector mistook event-loop lag (the machine being busy) for the machine going to sleep. It already ignored lag when CPU load was clearly high — but load fluctuates, so lag bursts slipped through whenever the 1-minute load average momentarily dipped. This adds a simpler, load-independent rule: a real sleep is ONE isolated hiccup; a string of back-to-back hiccups is the CPU choking, not repeated sleeps — so ignore the 2nd-and-onward.

## The problem (found 2026-06-07)

The SleepWakeDetector infers sleep from timer drift (timers freeze during real sleep). Under heavy load the event loop also lags, producing false "drift." #867 added a guard: short drift while the 1-min load ratio is high → suppressed as starvation. But the load average lags and fluctuates, so on a box bouncing between load ~8 and ~20, a 10-42s lag-drift that landed during a momentary dip below the threshold still fired a "wake" → a tunnel restart. Result: a tunnel-restart storm every 1-3 min (some timing out), churning recovery and piling on more load.

## What this adds

A load-independent signal: count consecutive drift ticks. A genuine sleep is a single isolated drift (the next on-time tick resets the counter); sustained CPU starvation produces back-to-back drifts. The 2nd+ consecutive SHORT drift is suppressed as a starvation burst — no matter what the (lagging) load average happens to read at that instant. Genuine long sleeps (≥5 min) are exempt and always emit (real-sleep recovery is essential), and the first drift in any burst still falls through to the existing checks, so an isolated real wake is unaffected.

- New `driftBurstSuppressFloor` (default 2; set 0 to disable).

## Why it's safe

- It only ever suppresses MORE false wakes, and only the 2nd-and-onward back-to-back SHORT drift. A single isolated drift still emits. A genuine long sleep is exempt.
- A suppressed false wake just means a tunnel restart that wasn't needed is skipped (the tunnel was never disconnected — there was no real sleep). The only cost is a delayed reconnect after a genuine short sleep that happens mid-starvation-burst — rare, and self-heals on the next on-time tick / activity.
- Pairs with fix A (durable reaper candidacy): A makes the reaper survive restarts, B reduces the restarts.

## Evidence

`tests/unit/sleep-wake-starvation-guard.test.ts`: 2nd consecutive short drift suppressed even under NORMAL load (the gap maxLoadRatio missed) and past the cooldown; with the guard off the same drift WOULD emit (proving the guard did it); an on-time tick resets the counter (isolated drifts both emit); a genuine long sleep is exempt. 13/13 green. `tsc --noEmit` clean.

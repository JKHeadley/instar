# Upgrade Guide — SleepWakeDetector false-fire-under-load hardening

<!-- bump: patch -->

## What Changed

On a CPU-saturated host the `SleepWakeDetector` was misreading a 20–33s event-loop stall as a
"~25s sleep" and firing the full wake-recovery cascade (tunnel restart, Slack reconnect, mesh-lease
churn, topic failover) roughly every 2 minutes. The existing back-to-back guard missed it because the
false cycle is ~2 minutes apart (on-time ticks between reset the consecutive counter). This adds two
corroboration signals to the short-drift path — a recent-drift timestamp memory (ON by default) and an
active-host signal (inert until wired) — so repeated short "sleeps" under load are recognized as CPU
starvation and suppressed. Genuine long sleeps (>= 5 min) and isolated short sleeps after a quiet
period still wake-and-recover exactly as before. Rollback lever: set the windows to 0.

## What to Tell Your User

- **Fewer phantom "the machine woke up" disruptions when things are busy**: "When the computer was
  very busy, I'd sometimes mistake the slowdown for the machine briefly sleeping, and over-react —
  restarting the tunnel, reconnecting Slack, and even bouncing our conversation to the other machine.
  That over-reaction was behind a few rough patches: a reply that lost the thread, messages that went
  unanswered, and 'typing is disabled.' I now tell a busy machine apart from a sleeping one, so I stop
  crying wolf. A real, longer sleep still recovers normally, and there's an instant off-switch if it's
  ever too cautious."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Repeated short "sleep" drifts under load are recognized as CPU starvation and suppressed | Automatic (on by default) |
| Genuine long sleeps and isolated short sleeps still wake-and-recover | Automatic (unchanged) |
| Instant rollback to pre-fix behavior | Set the SleepWakeDetector recent-drift / active-host windows to 0 |

## Evidence

New + updated unit tests in `tests/unit/SleepWakeDetector.test.ts` (16 pass, 7 new false/true-symmetric):
a repeating ~2-min short-drift cycle is suppressed; an isolated short sleep after a quiet period still
emits; a long sleep within the window still emits (real-sleep exemption); the active-host signal
suppresses an overlapping drift and is a no-op without a provider; both windows at 0 reproduce
byte-identical legacy behavior. `tsc --noEmit` clean. Designed from live measured root cause (loadavg
18–24 on 16 cores; `[SleepWakeDetector] Wake detected after ~33s sleep` every ~2 min on an
actively-used host). Independent Phase-5 second-pass review: concur.

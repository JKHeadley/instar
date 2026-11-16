# The safe core for machine restarts (not switched on yet)

<!-- bump: patch -->

## What Changed

Instar now has one place that can restart a machine, with its safety limits built in: every attempt is written down before it happens, a restart is never tried twice at once, automatic restarts are capped (never within six hours of the last start, at most two a day for a stuck machine, one scheduled restart every five days), and anything already unclear (a restart that was asked for but has not happened) stops further automatic ones. It refuses to run inside a test or a throwaway agent. Nothing uses it yet: your one-tap opt-in per machine and the Restart now button come next.

## What to Tell Your User

- **Machine restarts**: "I've built the safe core for restarting your machines myself, with hard limits on how often. It isn't switched on: nothing restarts until you opt a machine in with one tap."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Restart core with brakes | Internal; used by Restart now and scheduled restarts once a machine is opted in |

## Evidence

- Unit: `tests/unit/machine-restart-actuator.test.ts`.

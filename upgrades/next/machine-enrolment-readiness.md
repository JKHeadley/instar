# Machine care shows whether a machine could restart by itself

<!-- bump: patch -->

## What Changed

Machine care now reads, for each machine, whether it could come back on its own after a restart (on a Mac: no startup password and automatic login; on Linux: no disk password and the agent set to start), and whether it may be offered for self-maintenance at all (never a test agent, a machine marked as not ours, or while someone else is using it). When something is missing, it names the one setting in plain words. Nothing is switched on or restarted by this.

## What to Tell Your User

- **Machine care readiness**: "I can now tell you, per machine, whether it could restart and come back by itself, and if not, the one setting that's missing."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Restart readiness per machine | Ask "can this machine restart by itself?" |

## Evidence

- Live on the Mac Studio 2026-11-16: reads ready (FileVault off, automatic login, all agents start at login).
- Unit: `tests/unit/machine-enrolment-readiness.test.ts`; integration: `tests/integration/machine-maintenance-route.test.ts`.

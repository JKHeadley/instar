<!-- bump: patch -->
## What Changed

Groundwork for "Always available" on Mac. When the Instar app runs an agent as a system service, it leaves a record, and Instar's start-up helpers (auto-start install, the fleet watchdog, restart commands, recovery and update self-heals) respect it so the agent never runs twice. Nothing changes until the app's switch is turned on.

## What to Tell Your User

Nothing yet. This prepares the Always available switch coming to the Mac app.

## Summary of New Capabilities

- The `/Library/Application Support/Instar/always-available/<agent>.json` record, respected by every per-user start path.

## Evidence

`tests/unit/always-available-guards.test.ts` covers the record rules, the funnel refusing and refreshing the wrapper, the watchdog block under `set -euo pipefail`, and the recovery refusal.

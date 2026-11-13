# A restart deferral the running process already satisfies is dropped at start

<!-- bump: patch -->

## What Changed

`AutoUpdater` keeps a durable restart deferral (`state/auto-updater.json` → `restartDeferral`) when an installed update's restart must wait for in-flight work. `start()` re-arms its retry from that record. The record was cleared only when the updater itself performed the restart. When anything else restarted the server while the deferral waited (a planned restart request, the supervisor, a crash), the new process booted on the target version, resumed the stale deferral and restarted again onto the version it was already running. While a deferral is pending, Local Verify pauses dispatch.

`start()` now calls `dropSatisfiedRestartDeferral()` first: when a deferral is active, `ProcessIntegrity` holds the version this process booted with, both versions parse, and the target is not newer than the running version, the deferral is cleared and state saved. Otherwise nothing changes.

## What to Tell Your User

Nothing changes that you will see, except that after some updates the agent used to restart twice in a row and now restarts once.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| No second restart onto the version already running | Automatic |

## Evidence

Studio server log, 2026-11-13 (UTC): 18:57:44 v1.3.1758 installed, restart deferred for a verify run; 19:20:03 a planned restart request was honoured when the run ended; 19:20:45 `[AutoUpdater] Started` on 1.3.1758; 19:21:31 `durable deferral resumed — attempting restart for v1.3.1758`, then `Restart deferred for v1.3.1758: held for in-flight work`. `GET /updates/status` at 19:22 showed `currentVersion: 1.3.1758` with `restartDeferral.active: true, targetVersion: 1.3.1758`.

Tests: `tests/unit/AutoUpdater-restart-holds.test.ts`, 4 new: dropped (and the durable record cleared, no restart request written) when the process runs the target version; dropped when it runs a newer one; kept, and the restart still happens, when it runs an older one; kept when no boot version is recorded or a version does not parse. `tests/unit/stale-version-prevention.test.ts`, 1 new: the server source initializes the boot-version record before it starts the updater. The four AutoUpdater unit files pass (57 tests).

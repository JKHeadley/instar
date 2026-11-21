# Turning auto-updates off cancels an update that was already waiting to install

<!-- bump: patch -->

## What Changed

When an update check finds a new version and auto-updates are on, the agent waits five minutes (in case a newer release follows) and then installs. Before this fix, setting `updates.autoApply` to false during that wait did not stop the install: the waiting timer was never cancelled and the install step never re-read the setting, so the update landed anyway. Now turning auto-updates off, through the config file (picked up by LiveConfig) or `PATCH /updates/config`, cancels the waiting install at once; the install step re-reads the setting just before installing and refuses when it is off; and a check that finds the setting off cancels any waiting install. `PATCH /updates/config` now also returns `cancelledQueuedUpdate: true|false`. A manual apply (`POST /updates/apply`) is unchanged and still works with auto-updates off.

## What to Tell Your User

- **Auto-updates off means off**: "If you turn off automatic updates, I now also cancel an update that was already lined up to install in the next few minutes. You can still ask me to update whenever you like."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Turning auto-updates off cancels a waiting install | Turn auto-updates off (ask the agent, or `PATCH /updates/config {"autoApply": false}`); the response says whether a waiting install was cancelled |

## Evidence

Windows dress rehearsal (builder #43, 2026-11-20, agent "Wintest"): the first check at 00:10:40 queued v1.3.1940 behind the 5-minute delay; `updates.autoApply false` was written at 00:13:03 and LiveConfig logged the change; at about 00:15:40 the agent still applied v1.3.1940 and restarted. New tests reproduce it: on main, 6 of 9 unit cases, 2 of 3 integration cases and the e2e config-edit case fail (the update installs); with the fix all pass, and the positive controls (auto-updates left on installs; a manual apply still installs) pass on both.

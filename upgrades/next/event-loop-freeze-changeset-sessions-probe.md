# Upgrade Guide — event-loop-freeze-changeset-sessions-probe

## What Changed

Two jobs could hold the server's event loop until it stopped answering (fb-53f6f120-219). The feedback executor read every file of two whole code trees with blocking calls when an attempt finished; on the Studio that ran past 84 seconds and the supervisor killed the server. `buildChangeSet` now does those reads asynchronously, with the same checks in the same order, and so does `treeBytes`, the disk-cap walk that runs on every tick for each live attempt. `GET /sessions` no longer runs the reaper's full per-session evaluation for its discrepancy probe; it reads the ids through `SessionReaper.trackedSessionIds()`.

Also repairs a break on main: two app conversation writes in the same millisecond could fail on a name collision, because the context file name used only the clock.

## What to Tell Your User

I should freeze and restart less often now. Two slow background jobs were blocking me from answering anything while they ran, and neither does that any more.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Server keeps answering while a feedback fix is checked, and while sessions are listed | Automatic |

## Evidence

Live CPU profiles on the Studio named both code paths. `tests/unit/feedback-factory/execute-units.test.ts` proves the event loop keeps turning during a build (0 turns with sync reads restored, over 300 with the fix). `tests/integration/session-reaper-routes.test.ts` proves `GET /sessions` runs no per-session checks and still logs a mismatch. On a real 21,261-file tree the longest event-loop gap was 50 ms.

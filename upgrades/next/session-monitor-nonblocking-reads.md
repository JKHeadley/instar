# The session monitor's per-poll checks use the non-blocking tmux reads

<!-- bump: patch -->

## What Changed

`SessionMonitor.poll()` runs every 60 seconds. For every active topic session it called `isSessionAlive` (two synchronous tmux subprocesses: `has-session`, `display-message`) and, when alive, `captureOutput` (a third: `capture-pane`) on the server's main thread.

`SessionMonitorDeps` gains two optional members, `isSessionAliveAsync` and `captureSessionOutputAsync`. When both are provided the per-poll check awaits them. The server provides them where the async hot path is on (`monitoring.tmuxResilience.asyncHotPath.enabled`, dev-gated: on for development agents, off for the fleet), wired to `SessionManager.isSessionAliveNonBlocking()` (a public name for the existing tri-state `isSessionAliveAsync`) and the existing `captureOutputAsync()`.

Behaviour changes where the async path is on:

- A tmux that does not answer in time is `'indeterminate'`, and the monitor reads that as alive and skips the screen read for that poll. The synchronous check timed out after 5 seconds and reported the session dead, which could start recovery of a session that was only slow to probe. A session tmux reports as absent is dead in both. Five indeterminate polls in a row for one session are logged once and emitted as `monitor:liveness-indeterminate`.
- A poll can now outlast its 60-second interval when tmux is slow (the reads await, up to 9 seconds each). A tick that finds the previous poll still running is skipped, as before, and now logged.

Two fixes in the shared async tmux path that this caller needs (found in review), which apply to every user of that path:

- `tmuxExecAsync` now classifies `error connecting to <socket> (No such file or directory)` as definitely absent, alongside `no server running`. With no socket there is no tmux server and no session; before, that read as indeterminate forever, so after a reboot a session could never be seen as gone through `tmuxExecAsync`. This reaches the reaper and the other callers of that function; the boot purge reads tmux through `SessionLivenessOracle`, whose own classifier is not changed. Other connection errors (permission denied, connection refused) stay indeterminate.
- `captureOutputAsync` includes the line count in its single-flight key. Two overlapping captures of one pane at different depths were handed the same result (a 12-line caller could receive a 200-line capture, or the reverse).

With the gate off nothing changes.

## What to Tell Your User

Nothing changes that you will see. On development agents the once-a-minute health check of open conversations no longer makes the server wait on each one, and a slow machine is no longer able to make a healthy conversation look dead for a moment.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Session monitor per-poll checks through the async tmux path | Automatic where `monitoring.tmuxResilience.asyncHotPath.enabled` is on |

## Evidence

Studio, 2026-11-13, a 300-second caller-attributed CPU profile of the live server under test load: `tmuxSessionExists <- isSessionAlive <- checkSession <- poll` was the second largest synchronous `spawn` caller (1.1% of wall time), after the resume heartbeat (PR 3137). A near-freeze capture the same night (`logs/server-freeze/freeze-20261113T105518Z.txt`, three failed health checks) put 49.7% of the server's self time in `spawn`.

Measured on the Studio (tmux 3.7c, 41 sessions, three rounds): the three synchronous calls per session took 498, 497 and 491 ms in total, about 12 ms per session on a quiet machine.

Tests: `tests/unit/SessionMonitor-nonblocking.test.ts` (12, new: no synchronous read in a poll; the synchronous pair when only one async read is given; dead, unresponsive and screen-activity outcomes identical in both modes (each run through both); indeterminate is not dead and skips the screen read; a run of indeterminate answers reported once, counted per session and dropped when a peer takes the topic; a rejected read does not stop the poll; an overlapping tick is skipped and logged; the server wiring). `tests/unit/session-manager-is-session-alive-async-tristate.test.ts` (4 new: no tmux socket reads as absent; an unreachable socket stays indeterminate; the public tri-state name; captures at different depths are separate reads). Existing monitor and async-path tests unchanged and passing (the files run: 52 monitor, 23 tri-state, and 240 across ten neighbouring files).

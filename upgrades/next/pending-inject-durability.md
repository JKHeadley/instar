<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

Queued initial messages now survive server restarts. When a session is
spawned for an inbound message, the pending inject is recorded durably
(`<stateDir>/state/pending-injects/`) and cleared only after the message is
actually typed into the session. On boot, `recoverPendingInjects` sweeps
survivors: still-alive sessions get re-delivery through the normal readiness
path; dead or >6h-old records are reported via DegradationReporter and
retired — a loss is now always VISIBLE.

Why: the auto-updater restarted the server while a fresh codex session was
still booting; the in-memory pending inject died with the process, tmux
survived idle, and the operator waited 50+ minutes on a silently dropped
message (finding 8d300555). Delivery is at-least-once by design — a rare
duplicate beats a silent drop.

Also: the "Fresh-spawn fallback succeeded" log now honestly says "launched
(inject pending)" — it printed before the inject ran.

## What to Tell Your User

If your agent's server restarts at the exact moment you message it, your
message no longer risks silently vanishing — it is delivered when the session
finishes starting, even across the restart.

## Summary of New Capabilities

- `SessionManager.recoverPendingInjects()` — boot-time orphaned-inject sweep
  (wired automatically; not a user-facing surface).

## Evidence

13 new tests (store CRUD/corruption, all four sweep verdicts incl. the live
incident shape, and wiring-integrity through a real SessionManager: record
visible on disk DURING the spawn→inject window, cleared after). Adjacent
session suites green (53 tests); tsc clean.

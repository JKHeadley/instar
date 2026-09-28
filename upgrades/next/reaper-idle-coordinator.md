# The idle reaper no longer shuts down a session waiting on its own background work

## What Changed

The SessionReaper's 8-hour stale-idle rule (`reapStaleIdleWithActiveChildren`)
dropped the active-process veto for any session whose topic had no user message
in 8h. That rule was meant for idle MCP children, but it also discarded the
session's own running Claude Code shells. A 2.0 coordinating session on the Mac
Studio, waiting on builders through `run_in_background` watch loops in a topic
with no human message all day, was reaped three times on 2026-09-28; the third
reap hit the resume queue's resurrection cap and stayed down ~50 minutes.

- `SessionManager.hasLiveToolShell()` detects a live Claude Code tool shell
  (`…/shell-snapshots/snapshot-…`) under a session. The stale-idle relaxation no
  longer applies while one runs, and the cpu-flat relaxation
  (`cpuAwareActiveProcessKeep`) applies to it only at `critical` pressure.
- A session still reaped at critical pressure with a live tool shell carries the new STRONG work evidence `background-shell`, so
  the mid-work resume queue revives it.
- `hasActiveProcesses` no longer mistakes a direct-child tool shell (whose
  command line contains the `.claude` config path) for the Claude main process.

Genuinely idle sessions are reaped as before at every pressure tier.

## Evidence

- `tests/unit/session-reaper.test.ts`: stale topic + live shell is kept (also
  across 6 normal-tier ticks, and at moderate tier with a CPU-flat loop); a
  throwing probe keeps; stale + only idle children, a moderate-tier CPU-flat
  child with no shell, and a genuinely idle session are still reaped; a
  critical-tier cpu-flat reap carries `background-shell`.
- `tests/unit/SessionManager-live-tool-shell.test.ts`: detection on the real
  process tree captured from the coordinator, both sides.
- `tests/unit/work-evidence.test.ts`: `background-shell` is strong and eligible.

## What to Tell Your User

If I'm coordinating long work — waiting on other sessions to finish — the
automatic idle cleanup no longer shuts me down just because the chat has been
quiet. If the machine is truly short on memory and I do get shut down, I come
back and pick up where I was.

## Summary of New Capabilities

- Sessions with a running background shell are not treated as abandoned by the
  idle reaper; a pressure reap of one is revived (`background-shell` evidence).

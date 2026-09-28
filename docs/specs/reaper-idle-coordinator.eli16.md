# A session that is waiting on its own work is not idle: plain-English overview

## What happened

On 2026-09-28 the Mac Studio's idle cleanup (the "session reaper") shut down the
Instar 2.0 coordinating session three times in one day: 00:36, 07:33 and 10:24
PDT. Each time that session was running 4 to 8 builders in other terminal
sessions. It was waiting on them through background watch loops, small shell
commands that check every minute whether a builder has finished. Its own screen
was quiet because it was waiting, not because it was done.

The reaper has a rule for abandoned sessions: if nobody has written in a
session's chat topic for 8 hours, it stops treating the session's child
processes as a reason to keep it. That rule exists because idle helper
programs (plugin servers) otherwise keep a dead session alive forever. The
coordinator's topic had no human message all day, so the rule fired. The
reaper treated its watch loops like idle helper programs and shut it down.

The first two shutdowns were revived by the mid-work resume queue, because the
worktree had uncommitted files. The third was not revived: that queue brings
the same topic back at most twice in a window, a deliberate brake against
kill-revive loops. So the session stayed down about 50 minutes, until someone
posted into the topic by hand. Each shutdown cost the 2.0 build about an hour.

## What changed

- The reaper now asks one more question before using the 8-hour rule: is one
  of this session's own shell commands still running? Claude Code runs every
  shell command (including background ones) in a recognizable way, so this is a
  plain process check. If one is running, the session is kept. A session with
  only idle helper programs is still shut down exactly as before.
- A shell started by Claude Code has "claude" in its command line (its settings
  folder path). The general "is anything running?" check mistook it for Claude
  itself and ignored it. That check now counts it.
- The same holds when the machine is only moderately busy: a watch loop uses
  almost no CPU, and the reaper's "child uses no CPU, so it must be stuck" rule
  no longer applies to the session's own shell commands.
- When the machine is under critical memory or CPU pressure, the reaper can
  still shut down such a session. When it does, it now records "a background shell
  was still running" as strong mid-work evidence, so the resume queue revives
  it.

## What did not change

- Pressure-driven cleanup still works. Genuinely idle sessions are still shut
  down at every pressure level.
- The resume queue's two-revives brake is unchanged. It stops kill-revive
  loops. After this fix the normal idle path no longer shuts the coordinator
  down, so the brake should only be reached under repeated critical pressure.
- Every other keep rule is unchanged.

## Safeguards, in plain terms

The change only adds reasons to keep a session. It never adds a new way to
shut one down. If the process check cannot run, the answer is "keep". The one
cost: a session whose topic is silent and that has a forgotten background
command (for example a dev server) is kept at normal load. Under pressure it
is still shut down, and then revived once or twice at most.

## Who decides what

Nothing here needs an operator decision. It restores the behavior the reaper
promises ("never reap a session that might be working") for sessions that wait
on their own background work.

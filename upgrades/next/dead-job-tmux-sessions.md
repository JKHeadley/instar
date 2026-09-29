# Finished job sessions no longer leave dead tmux sessions behind

## What Changed

Job sessions keep `remain-on-exit failed` so the monitor can read a failed
exit status. When a job's process exited non-zero, the monitor marked the
session completed but never killed the retained dead pane. Job session names
are unique per run, so no later spawn reclaimed it (topic sessions are
reclaimed by their next same-name spawn). The groky agent on the Mac Studio,
whose Grok jobs exit non-zero during startup, left about 1,000 dead
`groky-job-*` sessions per day on the shared tmux server.

- After the monitor records a job session's self-exit, it removes that tmux
  session. `pane_dead` is re-probed for every pane in the session first; if any
  pane is live (for example one an operator split in) or the read is uncertain,
  the session is kept.
- `SessionManager.sweepDeadJobPanes()` runs every 5 minutes (at most 50
  candidates examined per pass, counted whether or not they are removed; a tmux
  read that times out ends the pass) as a backstop for dead job panes a completion path missed. It only
  kills a session named `<agent>-job-*` whose pane is dead, whose tmux
  environment carries this agent's `INSTAR_AGENT_HOME` and an
  `INSTAR_JOB_SLUG`, and which no running session record owns.

Interactive sessions and other agents' sessions are never touched.

## Evidence

- `tests/unit/dead-job-pane-cleanup.test.ts`, on a real tmux server on a
  private socket: a job that exits non-zero is marked completed and its tmux
  session removed, while an interactive session's dead pane is kept; a live job
  session is left running; the sweep removes only this agent's dead, unowned
  job panes (a live one, one still owned by a running record, one without a job
  slug, another agent's, and a different prefix are all kept) and respects its
  per-pass cap. The first test fails without the fix.

## What to Tell Your User

My finished background jobs now clean up after themselves. Before, a job that
ended with an error could leave an empty terminal session behind, and those
could pile up by the hundreds and slow down the machine's session manager.

## Summary of New Capabilities

- Dead job sessions are removed automatically, plus a bounded 5-minute
  backstop sweep limited to this agent's own job sessions.

# Finished job sessions no longer leave dead terminal sessions behind: plain-English overview

## What happened

Every scheduled job an agent runs gets its own terminal session (a tmux
session), named after the agent and the job, for example
`groky-job-commitment-detection-mukocju4`. When the job's program ends, that
terminal session should go away.

On the Mac Studio, the agent "groky" runs its jobs with the Grok engine. Those
jobs were ending with an error code within about 16 seconds of starting. Instar
deliberately keeps a terminal open when its program ends with an error, so the
monitor can read the error code and record why the job stopped. The monitor did
read it, and it did record the job as finished. But then nothing closed the
terminal. Each job run has a unique name, so no later job ever reused and
cleaned up the old one. About 1,000 dead terminals piled up per day (987 were
cleared by hand on 2026-09-27 and 940 more on 2026-09-28). They all sit on the
one tmux server that every agent on the machine shares, which slows it down for
everyone.

## What already exists

- The monitor already notices when a job's program has ended, records the
  exit code, and marks the job finished.
- Chat (topic) sessions have their own cleanup: when the same chat starts again,
  the new session removes the dead terminal with the same name. That is why the
  pile-up only happened for jobs.

## What is new

1. Right after the monitor records that a job's program ended, it closes that
   job's terminal. Before closing, it checks every pane inside that terminal
   again; if any of them is still running (for example a pane a person opened
   to look around), the terminal is kept.
2. A small backstop sweep, every 5 minutes, looks at no more than 50 dead job
   terminals that were missed (for example ones left over from before this
   fix, or from before a restart). It only closes a terminal when all of these
   are true: its name starts with this agent's job prefix, its program has
   ended, its recorded environment says it belongs to this agent's home folder
   and to a job, and no running job record still owns it.

## Safeguards in plain terms

- A terminal with any pane still running is never closed.
- Another agent's terminals are never closed: the sweep checks the owner
  recorded inside each terminal, not just its name.
- Chat sessions are not touched by this change. Their existing same-name
  cleanup stays as it is.
- The sweep is bounded (50 terminals looked at per 5 minutes, whether or not
  they get closed, and it stops early if tmux is slow to answer) so it can
  never flood the shared tmux server with commands or hold up the monitor.

## What the reader needs to decide

Nothing. This is a cleanup fix with no settings and no user-visible behavior
beyond the dead terminals no longer piling up. Separately worth knowing: the
groky agent's Grok jobs are failing within 16 seconds of starting; this fix
removes the leftovers but does not fix why those jobs fail.

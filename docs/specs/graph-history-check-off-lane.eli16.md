# The slow history check no longer holds up saves (plain-English overview)

**What happened.** After this morning's fix, Accept all worked and reached 6 of 20 projects. Then the Studio restarted and the run kept stopping at "Stopped at 2 of 14: your agent is not answering right now". The log line added by the morning fix named the cause: one check had taken 450 seconds, 7.5 minutes.

**Why.** That check re-reads your whole saved conversation history from disk to make sure it is intact. The morning fix made it reuse its last result when nothing had changed. Right after a restart, though, there is no earlier result, so the first check always reads everything. On the Studio that takes minutes. It ran inside the step that handles one job at a time, the same step every save goes through. So every save waited behind it until the page gave up.

**What changes.** The check now runs on its own in the background, one at a time, instead of inside that one-job-at-a-time step. Saves no longer wait for it. The check still refuses its result if anything was saved while it was reading, and it starts again later. When it takes more than 2 seconds, the log says how long.

**What stays the same.** Every check a save must pass, who may save, and how the machines confirm a change. The only thing this check builds is an older-copy view for reading while the machines are catching up. A save that needs that view in the first minutes after a restart now gets a quick "try again" instead of a long wait.

**What you need to decide.** Nothing. It is small and reversible (Tier 1), and a revert undoes it.

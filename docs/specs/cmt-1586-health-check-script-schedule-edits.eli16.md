# Health check as a cheap script, and schedule edits that stick — Plain-English Overview

> The one-line version: on a development agent the health check can finally run as its free plain script instead of starting an AI session every 5 minutes, and a changed schedule for a built-in job is no longer undone by the next update.

## The problem in one breath

Echo's health check starts a small AI session (Haiku) every 5 minutes, about 99 million tokens a day, even though a plain script that does the same check in a tenth of a second has been installed for weeks. Turning the script on in Echo's settings did nothing. Separately, when Echo slowed the health check from every 5 to every 10 minutes, the next Instar update quietly put it back to 5.

## What already exists

- **Script mode for built-in jobs.** Many scheduled jobs ship two ways: as an AI session (the old way) and as a plain script that costs nothing to run. A settings list chooses which jobs stay on the old way.
- **A safety lock built into the code.** On Oct 27, Justin asked that every call to Jev or any AI model go through our benchmark auditing before it is switched on. So script mode is locked in code for every job except one (the grading job). Settings cannot unlock it. That lock is why Echo's settings change did nothing.
- **The update installer.** Every update rewrites each built-in job's files from the shipped copy. It already keeps two of the operator's choices: whether the job is turned off, and why. It did not keep the schedule.

## What this adds

The health check joins the grading job as a job allowed through the lock. Justin's rule is about AI calls. In script mode the health check makes none: it only reads the agent's own health page and the free disk space, and the step that would send unusual results to Jev for a second opinion is still switched off in code. So letting it through adds no unaudited AI call, and it removes one, the Haiku session every 5 minutes.

The installer now remembers the schedule it shipped for each built-in job. At the next update, a different schedule means someone changed it on purpose, so it is kept. If the schedule still matches what was shipped, it follows any new default.

## The safeguards

**Other agents are unchanged.** The health check only switches to script mode where script mode is already on (development agents, or an agent whose owner turned it on) and the settings no longer list the health check. Every other agent keeps today's behaviour.

**Easy to undo.** Putting the health check back on the settings list returns it to the AI session at its next run, with no restart.

**A broken schedule edit can't break the job.** If a saved schedule is not a valid schedule, the update restores the shipped one and reports it.

**Agents learn about it.** Each agent's instructions gain a short note on where to change a built-in job's schedule so it survives updates.

## What the reader needs to decide

Nothing. This follows Justin's Oct 27 rule as he worded it. One thing to know: Echo's earlier change to every 10 minutes was already undone by the 7:32 AM update. After this ships it needs setting once more, and from then on it will stay.

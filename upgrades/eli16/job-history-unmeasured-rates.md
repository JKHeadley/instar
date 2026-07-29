# Jobs with no runs no longer look completely unsuccessful

The job-history API reports how many completed runs succeeded and how long runs
took. It also builds category reports so an overseer can see performance across
several related jobs.

Previously, a job with no completed runs reported a zero-percent success rate
and a zero-second average duration. The category report then averaged that
invented zero with real job rates. A category with one job at 75 percent and
one job that had never run appeared to be at 37.5 percent, even though the
second job provided no evidence at all.

Per-job success rate and average duration are now null until a completed run
supplies the relevant sample. Category reports exclude those null rates from
the average, and return null when no job in the category has a measured rate.
Counts such as total runs, successes, and failures remain zero because those
are real counts, not ratios. Scheduler state, job execution, health decisions,
and history storage are unchanged.

The regression creates an unknown job and asserts zero completed runs alongside
null rates. A second test proves that a measured 75-percent job remains 75
percent when an unrun job is present, while two unrun jobs produce a null
category average. Restoring the old zero fallback makes the test fail. This
keeps “nothing happened” distinct from “everything failed.”

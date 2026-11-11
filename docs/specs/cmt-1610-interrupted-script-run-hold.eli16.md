# A restart no longer locks a job out of its free script — Plain-English Overview

> The one-line version: if the server restarts while a scheduled script is running, that run is now written down as "failed, interrupted" instead of locking the job onto its expensive AI-session fallback forever, and any such lock can be lifted with a recorded reason.

## The problem in one breath

Echo's health check had just been switched to its free plain script. Thirty minutes later the server restarted while one health-check run was in the middle of working. That run was never finished in the records. On the next start, a safety check compared the two record books (the run history and the supervision record), saw a run that never finished, called it a mismatch, and put a permanent hold on the job. There was no way to lift a hold. So the health check went back to starting a small AI session every 5 minutes, about 99 million tokens a day. The grading job had been stuck the same way for a week.

## What already exists

- **Two record books for every script run.** The run history says a run started and how it ended. The supervision record keeps a matching row so every result can be checked later.
- **A restart check.** At startup the scheduler compares the two books. If they disagree, it holds the job: the job keeps working, but through its older AI-session path, until someone looks. That safety idea is good and stays.
- **No way out.** A hold could be written but never removed.

## What's new

1. **An interrupted run is settled, not treated as a mismatch.** At startup, a script run that this machine started, that is still "running" in the books, and whose process no longer exists is recorded as failed with the reason "interrupted: the server stopped before this script finished". Both books get the same answer, so the check passes and the job keeps its free script.
2. **The same check can lift its own hold.** If a hold was written by the restart check and that check now finds nothing wrong for the job, the hold is lifted and the lift is recorded (who: the check; why; and when the hold had been written).
3. **A recorded manual release.** There is now a page to read a job's hold and its release history, and a way for me to release a hold with a written reason. It refuses while a run still disagrees between the two books, so a hold can only be lifted once its cause is really settled. Nothing is ever deleted silently.

## Safeguards

- Real disagreements still hold the job: a result that differs between the two books, or a finished run with no matching record.
- Only this machine's own runs are settled. A run another machine recorded is left alone.
- A run young enough that it could still be running in an old server that has not quite shut down is left alone until that time has passed, then checked again.
- A hold for any other reason (for example a disk write that failed) is never lifted automatically.

## What you need to decide

Nothing. This is a correctness fix. On Echo, after the update the health check and the grading job go back to their free scripts on their own, and both lifts are on record.

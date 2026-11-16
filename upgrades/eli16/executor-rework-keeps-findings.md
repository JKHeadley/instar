# Retried fixes keep their safety-review notes — Plain-English Overview

## The problem in one breath

When the feedback executor writes a fix for a reported problem, two independent AI reviewers check it before it can merge. If they reject it, the pull request is closed after a day and the executor tries again, this time handing the new attempt the reviewers' notes so it can avoid the same mistakes. But it only looked one attempt back. If that retry never got going (for example, no session slot was free, or the server restarted), the attempt after it looked at the stalled retry, found no notes there, and started from scratch without them. That happened today: a fix rejected at 19:08 UTC got a retry that stopped ten minutes later for lack of a free slot, so the next try would have repeated the rejected approach.

## What already exists

The reviewers' notes are stored, cleaned of anything secret-shaped, by the executor itself. A retry receives them as a read-only data file that it is told never to take instructions from. A fix that fails review twice in the same round is parked for a person.

## What this adds

"The previous attempt" now means the last attempt that actually published a fix. Attempts that stopped before publishing anything are skipped, because they produced nothing new to review. So the notes from the last rejected fix reach whichever attempt next gets to run.

## The safeguards

Nothing about who reviews, what must pass, when a pull request closes, or who merges changes. The notes file is the same file as before, written by the same trusted code. If a later fix was published and closed for another reason, its newer code wins and the old notes are not passed on, the same as before.

## What ships when

Ships on merge. A revert undoes it.

## What you actually need to decide

Nothing.

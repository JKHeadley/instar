# Unconfirmed changes are retried a few at a time, not all at once (ELI16)

## What this changes

When the agent saves a change to its conversation graph, the other machine has to confirm it. If that confirmation does not come back, a background job keeps retrying until it does. While the retry job runs, it holds a lock on the graph, and anything else that wants the graph waits, including the other machine's own messages.

The retry job tried every waiting change on every run. Each try means re-checking the change and asking the other machine again, which can take seconds. With 50 changes waiting, as on our test copy tonight, each run held the lock so long that every message from the other machine timed out. Those messages were the very confirmations the waiting changes needed, so the backlog could never clear.

Now the retry job works like the one for already-confirmed changes: as soon as one change does not get through on a run, it stops trying the rest until the next run, and a change that keeps failing is retried less and less often. The lock is released quickly, the other machine's messages get through, and the backlog clears.

A third, smaller fix: while checking its records, the agent re-read its list of machines and its own identity files from disk once for every record (about 550 times in a row) to confirm it was still allowed to work. It now skips that check when nothing at all could have happened since the last one (the previous record finished without waiting on anything), and checks again as soon as anything else could have had a turn.

## What stays the same

No change is dropped; every waiting change is still retried. Changes that do get through are finished exactly as before. Saving a change yourself, for example with Accept all, does not go through this job and is not slowed down.

## Safeguards

Tests check that a run stops after the first change that does not get through, keeps going while changes do get through, still reaches every change over several runs, and clears the slow-down once a change finishes. Undoing the one commit restores the old behaviour.

## What you need to decide

Nothing.

# A waiting restart no longer cuts off a helper machine's test run

## What this is

Instar tests every change on more than one machine. One machine (the coordinator) hands a full test run to a helper machine and collects the result when it is done. When the coordinator needs to restart, for example to load an update, it waits for the helper's run to finish first, because a restart in the middle throws that run away.

That wait had a fixed limit: 21 minutes from the moment the run was handed out. The number came from a measurement taken when a helper run took about 13 minutes.

## What went wrong

The test suite grew. A helper run now takes 22 to 25 minutes. On 2026-11-15, 37 of 38 passing helper runs took longer than 21 minutes. So the wait gave up a minute or two before the run would have finished. On that day the coordinator restarted 5 to 10 seconds after the limit passed, and a run that was nearly done (22 minutes of work on the helper) was thrown away and had to be done again.

## What changes

The limit is no longer a measured run time. It is the longest a helper run is ever allowed to take (60 minutes) plus one minute to collect the result: 61 minutes. A test now checks that the limit is never smaller than that allowance, so the two numbers cannot drift apart again when the suite grows.

In the normal case nothing waits longer than before. The wait ends the moment the helper's result is collected, which is 22 to 25 minutes after the hand-out. The 61 minutes only matters for a helper that keeps answering but never finishes.

## What keeps it safe

- A helper that goes quiet stops holding the restart within about two minutes. That is unchanged.
- If the coordinator's own record of the helper goes stale (90 seconds), the wait ends. That is unchanged.
- No restart request can wait more than three hours in total, and an update's own four-hour ceiling still applies. Both unchanged.
- A forced restart ignores the wait completely. That is unchanged, and it is what was used on 2026-11-15 to load a critical security fix at once.
- No new test runs are handed to a helper while a restart is waiting, so waits cannot chain.

## The cost

The worst case grows: a helper that answers but never finishes can now delay a routine restart by up to 61 minutes instead of 21. The 60-minute limit on any helper run is what ends such a run.

## What you need to decide

Nothing. This is a small, reversible correction to a number, with tests on both sides of the limit. Reverting it restores the old behaviour with nothing to clean up.

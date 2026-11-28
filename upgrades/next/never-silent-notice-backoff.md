# A failing never-silent notice is retried with a growing wait and counted once

## What Changed

When a never-silent notice did not go out, the watcher tried it again on every sweep, about every 30 seconds, and every failed try counted as one error. On the Studio from 20 to 27 November, 59 failed tries came from only 11 incidents, and one incident alone made 33 of them.

Now a failed notice waits before its next try: 30 seconds, then 60, doubling up to 15 minutes, separately for the waiting notice and the status notice of each incident. A delivered notice resets the wait. Every try is still written to the never-silent log with its try number, so the old per-try count stays readable. The feature-evidence error count now takes one error per failure streak of an incident and notice kind (the first try that really failed), and a notice the notification gate held quiet, or one that came back with no message id, counts as neither an error nor a send. This is step 2 of CMT-2078.

## What to Tell Your User

Nothing changes in your conversations, except that when a "still working on it" notice cannot get through, I stop trying it every half minute and space the tries out instead.

## Summary of New Capabilities

No new capability. Failed never-silent notices back off instead of retrying every sweep, and the error rate counts one error per failure streak of an incident instead of one per try.

## Evidence

Before: logs/never-silent.jsonl on the Studio, 2026-11-20 to 2026-11-27: 59 `notice-undelivered` rows from 11 incidents, one incident retried on every sweep for 33 rows. After: tests/unit/neverSilent-watcher.test.ts runs ten minutes of 30-second sweeps against a failing sender and sees five tries (try numbers 1 to 5) instead of twenty-one, only the first counted as an error; the wait stops growing at 15 minutes; a delivered notice resets the count; a streak that starts held and then really fails counts once; a failing status notice backs off too; and the evidence mapping counts held-quiet and no-message-id as neither an error nor a send.

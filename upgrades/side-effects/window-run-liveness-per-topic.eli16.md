# Two autonomous runs can now run at once (plain English)

## What happened

When Echo starts a long autonomous run, a part of the server called "window-run liveness" watches it: is the session alive, is it writing progress, is it still inside its time window. It keeps a small record for each run it watches.

The problem: it only had room for ONE record for the whole agent. That made sense when it was built in September, because it watched one special overnight "window" at a time. In October ordinary runs were allowed in too, but nobody gave each topic its own record. So when one topic had a run going, any other topic that tried to start one was refused ("another run is already active") and its run sat in "preparing" forever. On 1 November that is exactly what happened to topic 131439 while the quota topic was running. Echo's own instructions say up to five runs can go at once, one per topic, so the single slot was a mistake, not a rule.

## What is new

- Each topic gets its own record, in its own file, with its own lock. A run in one topic never blocks a run in another.
- The 30-minute progress clock that goes with each run is split the same way.
- The old single record is moved into its topic's file automatically the first time the server reads it, so a run already in progress keeps going.
- One rule is added: the same window name can't be live in two topics at once (that would mix two runs' progress together).
- Anyone reading the status can ask for one topic (`?topicId=`) or see all of them.
- Echo's instructions now say "one per topic", and existing agents get that line when they update.

## Safeguards

Inside one topic nothing changes: a second run still waits for the first to finish, each run still gets exactly one recovery attempt, and the overall limit of five runs at once is still enforced where it always was. If one topic's check fails, the other topics are still checked.

## What you need to decide

Nothing. This only affects Echo (the feature is off for everyone else). Undoing it is a revert plus moving the record file back, which is written down in the review notes.

Follow-up: an automatic check that counts "error swallowed quietly" spots flagged two old error handlers next to the new code. Both already send the error back to the caller, so they were labelled as fine. Nothing about how the agent behaves changed.

Second follow-up: some tests used stand-in versions of the liveness checker that still answered in the old "one run for the whole agent" format. They now answer in the new per-topic format. One test that still expected the old rule now checks the new one.

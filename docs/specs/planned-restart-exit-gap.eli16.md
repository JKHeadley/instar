# A planned restart no longer cancels a test run that has just finished — Plain-English Overview

> The one-line version: a routine restart used to be able to slip in during the split second between a test run ending and its result being written down, and throw the whole run away. Now it waits until the server has started handling the finished run, and from that point the existing rules protect the result.

## The problem

Before a change can be merged, this machine runs the full test suite against it. One run takes 20 to 40 minutes. The run happens in a separate helper process, and the main server writes the result down when the helper process ends.

The server also restarts itself for routine reasons, such as loading an update. A routine ("planned") restart is supposed to wait while a test run is in progress. It decided whether a run was in progress by asking one question: is the helper process still alive?

That question has a blind spot. When the helper process ends, there is a short moment before the server notices and writes the result down. In that moment the helper is no longer alive, so the restart believed nothing was running and went ahead.

On 2026-11-19 at 01:18 UTC this happened for real. A test run had been going for 39.6 minutes. Its helper process had just ended successfully. Before the server wrote the result down, a routine restart looked, saw no live helper, and restarted the server. The server cancelled the run on its way out and the finished result was thrown away. The change had to be tested again from the start. The same thing had happened once before, on 2026-11-13, to a 24-minute run.

## What changes

**The restart now waits for the server to start handling the finished run.** The server keeps a small note on disk while a run is unfinished business. When the helper process ends and the server gets to it, the server does three things in one uninterrupted step: it writes a second note that says "a result is being passed on" (the "settling" note), removes the first note, and writes the result down. The restart now pays attention to the first note, not only to whether the helper is alive. If the helper is gone but the note is still there, the server has not started that step yet, and the restart waits. Once the step starts, the settling note is already on disk and keeps the restart waiting under the existing rules.

**The wait is short and cannot repeat.** It lasts at most 60 seconds, counted from the first moment anything sees the helper gone. The server normally gets to the finished run in well under a second, so 60 seconds is generous. The moment the first note is removed, this wait ends; it does not sit out the full minute. The starting moment is saved in a small file, because two separate programs check for restarts (the server itself, and the watchdog program that looks after the server) and both must count from the same moment.

**A crashed server cannot hold a restart hostage.** If the server died and left its note behind, nothing will ever remove the note. The 60-second limit covers this: the restart waits one minute, once, and then goes ahead. It does not start a second minute on the next check.

**Restarts and what they cost are now counted.** Every time the server stops, the test service writes one line saying what the stop interrupted: which local test run (and how long it had been going, and whether its helper had already ended), and which runs handed to other machines had not come back yet. It writes the line even when nothing was interrupted, so clean restarts can be counted too. The line also says whether the restart was a planned one and whether it was a forced one that skips the waiting rules. The same two facts are now recorded with every restart request and on the line the test service writes when it starts up.

**A thrown-away result is now said out loud.** There is one case where a finished result still cannot be kept: the server is already stopping, and a new version of the test software has been installed on disk. A result written down at that point would be ignored by the new version after the restart, and there is no time left to merge the change before the server exits (stopping has a hard 20-second limit, and merging takes several network calls). So the result is still discarded and the run happens again, exactly as before. What is new is that this is written down as its own line, with the reason, so it can be counted. The fix above is what prevents this case for planned restarts: they now wait before the server starts stopping.

## What stays the same

- A planned restart still waits for a running test run, for up to three hours and no longer.
- A forced restart still skips every wait, including this new one.
- A restart request that is itself three hours old still never waits.
- Crash recovery and emergency restarts are untouched. Only routine restarts wait.
- Once the server starts handling the finished run, the existing rules take over as before: a one-minute hold while the result is passed on, and up to ten minutes while the merge is carried out.
- The approved rule this builds on is in `planned-restart-local-verify-hold.md`. That document is not changed. It says the note "is cleared on completion"; this fix makes the restart respect that note until it is actually cleared.

## What it costs

A routine restart can now be delayed by up to 60 seconds in one situation: a test run's helper has ended and the server has not yet started handling it. In the normal case the delay is under a second plus the time until the next check (checks happen every 10 seconds). In the crashed-server case it is one minute, once.

## How we will know it works

- The test service's log gets a `restart-interrupted-runs` line at every stop. A planned, not-forced restart whose line names a local run that had already ended is the exact failure from 2026-11-19. After this fix that count should be zero.
- A `finished-result-discarded-at-shutdown` line marks every finished result that was thrown away. These should now appear only with forced restarts or stops that were not requested through the normal route.
- The watchdog program keeps running the code it started with until it is itself restarted. Until then only the server's own check has the fix. That is enough to close the measured failure, which went through the server's own check.
- Automated tests cover both sides of every limit: helper alive, helper gone with the note present, the 60-second limit to the millisecond, the note being removed early, a forced restart, an old request, and a note left behind by a dead server.

# A finished test run is no longer thrown away by a restart — Plain-English Overview

> The one-line version: when the server is restarted in the instant after a test run finishes, it now keeps that run's result; before, it could discard the result and run the same 25-minute test again.

## The problem in one breath

Every change to instar is tested by a full test run of about 25 to 30 minutes, one at a time per machine, before it can merge. The run happens in a separate helper process, which writes its verdict to a file as the last thing it does. The server then picks the verdict up and records it. When an update is waiting to restart the server, a guard holds the restart back for as long as the helper process is alive. The trouble is the moment in between: the helper has finished and gone, but the server has not yet picked up the verdict. The guard sees "no helper running" and lets the restart through. On a busy server that gap can be long enough for the restart to win. On 2026-11-13 it did: a run was stopped 121 thousandths of a second after it reached its verdict, the verdict was discarded, and the whole run started over.

## What already exists

- **The verdict file** — written by the test helper in one step when the run is over, so the file either holds a complete verdict or does not exist.
- **The restart guard** — holds a planned restart while a test helper is alive.
- **"Interrupted" handling** — when the server stops in the middle of a run, the run is put back at the front of the line and counted as interrupted. That is right when the run really was in the middle.

## What this adds

When the server is asked to stop, it first looks for the verdict file of the run in progress. If the file is there, the run is finished: the server records the verdict straight away, the same way it would have a moment later, and does not treat the run as interrupted.

## The new pieces

- **A check at shutdown** — "is there already a verdict for this run?" If yes, record it. If no, do what was always done.
- **Handled exactly once** — the server normally hears from the operating system that the helper has ended. That message can still arrive after the verdict was recorded at shutdown. The run is marked as handled, so the late message does nothing.

## The safeguards

**Only a complete verdict counts.** A half-written file is never read as a verdict, because the helper writes under a temporary name and renames it when complete. A test covers the temporary-file case.

**A passed run is not invented.** The verdict recorded is exactly the one the helper wrote, pass or fail. A run with no verdict file is still an interruption, as before.

**Not recorded twice, and not overwritten.** Without the "handled once" mark, the late message would have found the verdict file already gone and recorded a crash over the real result. A test fails if that mark is removed.

**Not used when an update has replaced the test machinery itself.** A verdict recorded by the old version would be ignored by the new one, so when the server can see that has happened the run is put back at the front of the line as before, where it will run again first.

**Merging still goes through every check.** Recording a verdict at shutdown does not merge anything. After the restart, the usual merge step picks the recorded pass up and applies all of its own checks.

## What is not fixed by this

If the server is killed outright instead of being asked to stop, this check never runs. And the restart guard itself still lets a restart through in the gap; this change makes the server cope with that, it does not close the gap. Both are tracked under the same commitment (CMT-1718).

## What you actually need to decide

Nothing. This is a small, reversible change in how the test line shuts down: no stored data or setting changes, and a revert restores the old behaviour.

## One more repair in the same change

A finished test run leaves a small result file for the server to read. If that file ever held something that is not a result (a stray word or number instead of the expected record), the server did not treat it as "no result". It tripped over it, and the run was never written down as passed or failed. Now anything that is not a proper result counts as no result: the run is recorded as crashed and tried again, which is what already happened for a missing or unreadable file.

This was found the honest way: a test added in this change fed the server such a file, and the trip showed up as a stray error after every test had passed. That stray error is why this change failed its own first run in the test line.

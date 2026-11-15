# Stop retrying a merge conflict straight away (plain-English overview)

## What this is

Instar tests every change on our own machines before it merges. If a test run ends in an error that is the machine's problem rather than the change's (a download failed, a process crashed), the test line tries the run once more by itself. That is a good rule for errors that can go away on their own.

## What went wrong

A merge conflict was treated as one of those errors. A merge conflict means the change and the main line both edited the same lines; trying again a second later, with the same change and the same main line, gives exactly the same conflict. So every conflicting change was tried twice, one second apart. Nothing was gained, every conflict was written into the records twice, and the notes sent about it doubled. On a day with many conflicts the counts looked twice as bad as they were.

## What is new

The automatic second try is skipped when the error is a merge conflict. Every other kind of error still gets its one automatic second try.

## What stays the same

A change that conflicted still leaves the line with an error and still has to be brought up to date by its owner, then requested again. Nothing about what counts as passing changes.

## Safeguards

A new test checks both sides: a conflict is not tried again, and a different error still is, exactly once. The existing tests for conflicts on a second test machine still pass.

## What a reader needs to decide

Nothing. This removes a retry that could never succeed.

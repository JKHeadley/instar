<!-- bump: patch -->
## What Changed

Local verification records now carry the time the coordinator first observed the pull request revision on GitHub. This makes the wait from discovery to the verdict measurable across admission, retries and server restarts.

## What to Tell Your User

Verification reports can show how long a newly observed revision took to reach a verdict. The clock starts when the coordinator sees the revision on GitHub. Older verdicts can lack this measurement.

## Summary of New Capabilities

The admission event, queue entry and verification record expose the optional Unix millisecond field `firstObservedAt`.

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

The pooled Codex follow-up unit tests control their temporary account query so a delayed shell process cannot change the result. They still resolve a real fixture transcript and now check that a timed-out account query is refused. The integration and end-to-end tests still start the fixture shell.

## What to Tell Your User

None — internal test fixture change.

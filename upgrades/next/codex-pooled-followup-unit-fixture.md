<!-- internal-only -->
<!-- bump: patch -->

## What Changed

The pooled Codex follow-up unit tests control their temporary account query so a delayed shell process cannot change the result. They still resolve a real fixture transcript and now check that a timed-out account query is refused. The integration and end-to-end tests still start the fixture shell.

## What to Tell Your User

None — internal test fixture change.

## Evidence

Studio main at 95f62b30 recorded three failures in this unit file. The retained assertion expected the temporary account transcript and received null. The exact same head passed a second shared run. The original failure could not be reproduced in isolation, and the retained record does not include the child process exit cause. The revised fixture supplies a timeout explicitly and checks that the resolver refuses delivery.

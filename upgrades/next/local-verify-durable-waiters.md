<!-- bump: patch -->

## What Changed

Local Verify retains the exact head of a ready pull request whose offer found the queue full. It rechecks waiting requests and retries ordinary admission as capacity returns. If the waiting list is full, the new request receives an explicit refusal while existing entries keep their place.

## What to Tell Your User

A pull request waiting for verification can now be picked up after a long queue delay without someone having to submit it again. Local Verify checks the current pull request before starting a test run.

## Summary of New Capabilities

- Durable, head-bound waiting requests with bounded retries through ordinary verification admission.

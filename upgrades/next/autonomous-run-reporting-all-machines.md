<!-- bump: patch -->

## What Changed

Autonomous runs now get a status message from their owner machine after a long topic silence, including on fleet machines where the older heartbeat was disabled. The message distinguishes observed session activity from progress, and names a paused run, suspended machine move, missing session, or missing output honestly. Reporting continues past the old per-run message cap. Stopped runs and runs owned by another machine do not send a local status.

## What to Tell Your User

You should receive sparse updates during long autonomous work, or a plain explanation when the run is paused or its session cannot be verified. You no longer need to check in to discover that it went quiet.

## Summary of New Capabilities

Automatic owner-machine updates for all autonomous runs after 30 minutes of initial topic silence, with later updates spaced by a durable cooldown of up to 90 minutes.

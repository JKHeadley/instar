<!-- bump: patch -->

## What Changed

A standby now checks whether the preferred machine still holds a healthy lease before trying to take over during its regular lease checks.

## What to Tell Your User

The standby waits while it can verify that the preferred machine is serving. It can still take over when the preferred machine's lease expires.

<!-- bump: patch -->

## What Changed

The app checks the signed lease once when it refreshes conversation bindings. It uses a non-blocking session check and reads current ownership again before closing a session that moved away.

## What to Tell Your User

None — internal change to app conversation maintenance.

## Summary of New Capabilities

None — internal change to app conversation maintenance.

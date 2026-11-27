<!-- bump: patch -->

## What Changed

Cartographer refreshes its node files through asynchronous filesystem requests during server startup. An inline summary edit receives a retry response while the same tree is rebuilding, so the rebuild cannot overwrite an accepted edit.

## What to Tell Your User

None — internal startup and cache maintenance.

## Summary of New Capabilities

None — internal startup and cache maintenance.

# Native update preflight

## What Changed

Instar now prepares each automatic update in a separate directory. It checks the new CLI startup and opens a real in-memory SQLite database with the Node runtime used for agent restarts before replacing the active install. A failed rebuild, missing package, startup failure, or failed SQLite query leaves the current install in place and keeps the update pending for retry.

Rollback uses the same checks. If an interruption occurs during the final switch, the boot wrapper and supervisor restore the previous installation before starting; existing agents receive the new wrapper through the update migration.

## What to Tell Your User

An update that cannot run safely will leave your agent online on its current version. Instar records the failure and retries the update on the next cycle.

## Summary of New Capabilities

- Pre-restart validation of the new installation and its native database dependency.
- Preservation of the active installation when preparation fails.

## Evidence

- Unit tests cover failed rebuilds, successful rebuild commands that leave a broken native module, and successful candidate promotion.
- A server lifecycle test covers the failed update through the production update route and verifies that no restart is requested.
- An integration test boots the real CLI and opens the real native SQLite binding, while a boot-wrapper test covers interrupted-switch recovery.

# An interrupted cleanup no longer blocks all future updates

## What Changed
An update keeps the old install as a backup while it swaps in the new one, then deletes the backup. If the server restarted during that delete, the half-deleted backup stayed, and every later update failed with "Previous install backup still exists; refusing to overwrite it". An update or rollback now retires a leftover backup at its start when the active install has its entry file. When the active install is missing, the backup is still restored as before, and when it has no entry file the backup is kept.

## What to Tell Your User
Updates and rollbacks no longer get stuck because a restart interrupted cleanup of the previous version.

## Summary of New Capabilities
- Updates recover by themselves from a leftover backup of the previous install.

## Evidence
Unit: tests/unit/UpdateChecker.test.ts, the leftover-backup test failed before the fix; other tests cover rollback, a failed delete, a broken active install, and restoring when the active install is missing. Live on Echo, 2026-11-07: applying 1.3.1703 at 04:44Z, the server restarted at 04:46 during the delete, and 1.3.1704 then failed to install at 08:17Z with that error until the leftover was moved aside by hand.

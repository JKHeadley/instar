<!-- bump: patch -->

## What Changed

After a planned restart, the serving machine records its first lease renewals and whether another machine confirmed them.

## What to Tell Your User

If the backup takes over after a restart, these records help identify whether the serving machine tried to renew its lease and whether it received confirmation.

## Summary of New Capabilities

The serving machine records the first three lease renewal attempts after it recovers from a restart.

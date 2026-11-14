# Updates that got stuck for good

To update safely, the agent keeps its old install as a backup, swaps in the new one, and then deletes the backup. The swap refuses to run if a backup already exists, so it can't overwrite one that might be needed.

That left a trap. If the server restarts while the backup is being deleted, part of it stays behind. The new version is running fine, but every later update sees the leftover and refuses, and keeps refusing until someone removes it by hand. An agent in that state silently stops receiving releases. It happened to Echo last night and blocked a release containing a fix.

Now each update and rollback checks first. If the active install has its main program file, a leftover backup is junk from an interrupted cleanup, so it gets removed. If that file is missing, the backup might be the only good copy, so it stays. If the active install is gone entirely, the backup gets restored, exactly as before. If the delete itself fails, the update still reports failure, as it did. Nobody has a decision to make, and undoing this is a plain revert.

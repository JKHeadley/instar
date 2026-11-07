# Upgrade Guide — vNEXT

## What Changed

A test for the failed-file diagnosis peer always used the same temp folder name. An empty leftover folder owned by another user made it fail on every run on that machine, which held every PR in the merge queue. It now picks a fresh name each run. Test-only: nothing that runs on an agent changed.

## What to Tell Your User

Nothing to tell. This keeps pending fixes moving and changes nothing you can see.

## Summary of New Capabilities

None.

## Evidence

On main at 40a131d93e the file failed 5 of 8 tests in three runs out of three on the Mac Studio, with EEXIST on /tmp/lv-1111... With this change, 8 of 8 pass on the same machine with the leftover folder still present.

## What Changed

- The automatic merger no longer skips a ready pull request just because GitHub's list says its mergeability is "unknown" (which happens after every merge). It reads that PR directly, which makes GitHub compute it, so the next round merges it.

## What to Tell Your User

Finished changes merge without someone having to open them first.

## Evidence

- On a live agent a verified PR was absent from every merge round until it was opened directly, and merged on the next round after that. Unit test covers the direct read for "unknown" and none for a real conflict.

## Summary of New Capabilities

None.

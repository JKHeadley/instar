## What Changed

Conversations custody checks avoid flushing the same unchanged files repeatedly during one check. Each new check still reads and validates current data. Saving changes and recording recovery decisions keep their disk-write checks. No setting change or outside service is needed.

This is part of the unfinished Conversations implementation. It does not mean the feature is deployed or that recovery is fully verified.

## Evidence

Focused tests cover file replacement, changed data, missing files, changed parent directories, failed writes, fresh checks and newly appearing negative controls. Full feature and deployment checks remain required.

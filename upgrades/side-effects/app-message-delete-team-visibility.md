# Team access visibility revision for private Delete sync

The Team Access Log exposes a process-local revision that changes when this instance changes its stored or folded access evidence. Revoking and then restoring a grant cannot restore an old revision. A read with no evidence change can reuse the revision.

This checkpoint changes no team permissions or wire behavior. A different conversation's access change can also advance the log-wide revision. Production must combine it with the other authority inputs before exposing a continuation.

## 6b. Operator-surface quality

An open client can detect a permission change even when the final permission list matches a previous list.

## Framework generality

The log revision is independent of the device client and agent harness.

# Atomic server lock publication

A server publishes its complete lock record with a hard link in the same state directory. The kernel refuses publication when another lock already exists. A failed hard link denies ownership. The temporary path is unique and cleanup is best effort.

This changes fresh publication for existing server lock callers. State directories on filesystems without hard-link support fail closed. Existing locks retain their file format and pathname. Stale-holder reclaim and release keep their existing behavior. Concurrent stale reclaim remains a separate Delete mounting requirement.

## 6b. Operator-surface quality

Two servers starting together keep one owner, so a later start cannot overwrite the winning lock.

## Framework generality

Server lock publication is independent of the agent harness.

# Retry managed work after a verified computer reboot

A worker can survive a restart of the server that launched it. It cannot keep running through a reboot of that computer. A fresh managed admission can now retire an unresolved worker after verifying that the same computer has rebooted and still owns the project. The old worker’s identity stays retired, so even a late callback cannot start another turn.

The new worker keeps the old worker’s remaining continuation budget. A pre-launch retry cannot reset it. A paused or completed task stays held. A conflicting task claim also leaves the old hold intact. Tests cover each of these conditions in the disabled-by-default branch. Production still needs to supply trusted local reboot evidence and wire the managed launcher before this path can run on real projects.

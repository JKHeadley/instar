<!-- bump: patch -->

## What Changed

When a machine takes over the serving lease, its local evidence log records what it knew about the previous lease and why the takeover was allowed.

## What to Tell Your User

If serving moves to a backup machine, I can use the takeover record to explain what the backup saw at the time.

## Summary of New Capabilities

The machine that takes over records the lease information it used and the reason it was allowed to take over.

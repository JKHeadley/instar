<!-- bump: patch -->

## What Changed

After a conversation moves between machines, the old machine now tells the others to check for the new owner right away, over a new signed signal that grants nothing. Before, they found out at the next regular check, measured at 28 seconds to over 3 minutes, and a message waited that long. Only agents with journal replication on are affected. If a signal is lost, the regular check works as before.

## What to Tell Your User

If your conversations move between your machines, messages sent right after a move should wait a few seconds rather than up to a few minutes.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| A new owner hears about a move in seconds | automatic; why a message waited is in `logs/feature-evidence.jsonl` under `multiMachine.sessionPool.moveNudge` |

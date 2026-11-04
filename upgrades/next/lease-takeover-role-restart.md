<!-- bump: patch -->

## What Changed

With the takeover switch on, a machine that gives up the lease now pauses its scheduled jobs at once, and a machine whose role changed restarts once so its jobs match its role. It stays off by default, and pools with a named preferred machine are unchanged.

## What to Tell Your User

Nothing changes for you yet. This is more groundwork so a backup machine can fully take over.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Jobs follow the lease role (off by default) | `multiMachine.leaseSelfHeal.soloCaptainHold.enabled` with no `preferredAwakeMachineId` |

<!-- bump: patch -->

## What Changed

The lease code can now take over on a pair of machines with no git remote: a local write counts, a holder keeps its epoch when its peer goes quiet, and a machine coming back asks its peers before taking back its own lease. All of it sits behind `multiMachine.leaseSelfHeal.soloCaptainHold`, which stays off by default, and pools with a named preferred machine are unchanged. Live power-off and link-cut drills come before it goes on for anyone.

## What to Tell Your User

Nothing changes for you yet. This is groundwork so a backup machine can take over when your main one dies, even with no git remote.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Takeover with no git remote (off by default) | `multiMachine.leaseSelfHeal.soloCaptainHold.enabled` with no `preferredAwakeMachineId` |

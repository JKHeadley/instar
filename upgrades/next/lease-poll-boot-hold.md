<!-- bump: patch -->

## What Changed

With Telegram polling set to follow the lease, a machine now waits for the lease before polling at startup, instead of polling first and stopping afterwards. This is off by default, so no agent changes on update.

## What to Tell Your User

Nothing to do. This prepares backup machines to stay quiet until they take over.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Boot hold for lease-following polling | automatic when `multiMachine.pollFollowsLease` is live |

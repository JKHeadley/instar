# A quiet standby does not connect to the Threadline relay

## What Changed

The relay admits one connection per agent identity, so two machines of one agent displaced each other (instar#2122). `bootstrapThreadline` gains `relayStandby`; `server.ts` passes `!shouldOwnTelegramPoll(config)` — the per-machine `multiMachine.telegramPolling: false` flag the lifeline already uses. A standby logs `relay connection SUPPRESSED (standby: …)` and keeps local Threadline. CLAUDE.md template + migration gain one awareness bullet.

## What to Tell Your User

When I run on two machines, only the one in charge connects to the agent network; the other stays quiet instead of knocking it off the relay every few seconds.

## Summary of New Capabilities

None — a connection gate on an existing flag.

## Evidence

`tests/unit/threadline/ThreadlineBootstrap.test.ts`: with the relay enabled and `relayStandby: true`, no relay client is created, the suppression line is logged, and local components still bootstrap. 148 template/migrator test files pass.

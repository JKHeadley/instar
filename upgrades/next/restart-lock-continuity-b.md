# A machine that goes away says why

<!-- bump: patch -->

## What Changed

When one of the agent's machines shuts down on purpose, it now tells the others why and when it expects to be back. Each reason comes from a record the machine wrote itself:

- **Restarting the machine:** a restart was actually started.
- **Restarting its server:** a server restart was requested.
- **Stopping:** neither of the above.

The others show this in the pool as "offline", with the reason. If the machine said it would be back and hasn't returned 10 minutes past that time, the pool says so.

The note clears as soon as a fresh server instance answers. It also clears if the same instance is still answering 15 minutes later, because then the shutdown didn't happen. A machine that disappears without announcing still reads as unreachable, as before.

## What to Tell Your User

- **Why a machine is away**: "When one of my machines restarts or shuts down on purpose, the others now know why and when it should be back, so I can tell you instead of guessing."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Machine-away reason in the pool | `GET /pool` shows `offline: <reason>` |

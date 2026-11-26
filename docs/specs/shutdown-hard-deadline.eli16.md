# ELI16 — the server always stops when asked

## What was wrong

When the agent's server is told to stop (the normal "please shut down" signal that the watchdog, the updater and the operating system all use), it shuts its parts down one at a time: the Telegram connection, the tunnel, the agent-to-agent link, the web server, and so on. It waited for each part to finish before moving to the next, with no time limit on the whole thing.

If any one part never finished, the server never exited. That is what Luna saw on the Mac Studio (instar#2122): a normal stop request did nothing, and only the forceful "kill" worked. A server that ignores a normal stop is a problem for everything that manages it, from updates to failover.

## What changes

- The moment a stop begins, a 20-second timer starts. If shutdown is still running when it goes off, the server writes a log line naming which part was stuck, saves what it can, and exits anyway. A fast shutdown is not slowed at all; the timer simply never fires.
- A second stop request during shutdown exits immediately, also naming the stuck part.
- The time limit can be changed with a setting if 20 seconds is ever too short.

The next time this happens, the log will say exactly which part hung, so the real cause can be fixed too.

## What you need to decide

This is a bug fix with no decision for the operator.

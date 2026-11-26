# ELI16 — "wake up here" now asks the right machine

## What was wrong

"instar wakeup" is how you move an agent from one machine to another: the machine you run it on asks the machine currently in charge to hand over. On Luna's Studio it did two things wrong (instar#2122):

1. It named the wrong machine as "in charge". It read an old role label from the shared machine list, which still pointed at a removed identity, instead of asking who actually holds the lease right now.
2. It sent the hand-over request to itself. It looked up its own server's address and posted the request there. The server then checked the request's signature as if it were the intended receiver, which it wasn't, so the check failed with "Invalid challenge signature".

## What changes

- Wakeup first asks its own running server who holds the lease right now, and only falls back to the machine list if no server is running.
- It then sends the hand-over to that machine, trying each of its known addresses (private network, local network, tunnel) until one answers. Its own address is never used. If none answer, it says so plainly and suggests the forced takeover.

## What you need to decide

This is a bug fix with no decision for the operator.

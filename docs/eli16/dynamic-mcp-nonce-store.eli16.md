# Dynamic MCP — the approval nonce store (ELI16 overview)

## What problem this solves

The dynamic-MCP feature lets the agent ask to load or drop a heavy tool, and if it
isn't preapproved, it has to get the operator's yes first. But here's the trap: the
agent talks to its own server using a shared key — so what stops the agent from
just *claiming* "the operator said yes"? If we trusted a simple "approved" flag,
the agent could rubber-stamp itself, and the whole "ask the human first" rule would
be theatre.

## The fix: a one-time code

When a non-preapproved request comes in, the SERVER (not the agent) generates a
random one-time code and ties it to that exact request — this topic, this action
(load or drop), this specific tool. The agent is told "you need approval," and the
real operator's yes — coming through a channel only the operator controls (the
dashboard PIN, or a verified reply) — carries that code back. Only then does the
server let the change through.

Because the code is random, server-issued, and tied to the exact change, the agent
can't forge one, can't reuse an old one, and can't take a code meant for "load
playwright" and use it for "drop something else." A code works exactly once, then
it's gone. And it expires after a few minutes, so an unanswered request doesn't
leave a usable code lying around.

## Why it's safe

It's a small in-memory ledger: hand out a code, check-and-burn a code. It holds no
secrets and changes nothing on the machine. Eight tests pin every rule: works once,
fails on reuse, fails on a wrong code (without burning the real one), refuses a code
replayed against a different topic/action/tool, expires on time, and a fresh
request replaces the old code. It isn't wired to anything yet — the approval routes
that use it come next.

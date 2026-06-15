# WS2 Send-Side Emission — ELI16

## What is this?

Your agent can run on more than one machine — say a laptop and a Mac mini. The goal of
the multi-machine memory work is simple: a memory the agent forms on the laptop (a lesson
it learned, a person it remembers) should also be known on the mini. An earlier fix made
the two machines correctly *announce* to each other "yes, I can receive these memories."
But when we actually tested it live, a lesson written on the laptop never showed up on the
mini, even after waiting.

## What was broken?

Think of it like two offices that agreed to share their filing cabinets. The announcement
fix was both offices saying "send me copies of your files." But it turned out the laptop
was never actually *putting its files in the outbox*. Each part of the agent's memory
(lessons, people, knowledge, users) already had a little "drop a copy in the outbox" button
wired up — but the button wasn't connected to anything. The code literally said "we'll
connect the real outbox later," and "later" never came. So every memory write pressed a
button that did nothing, and the outbox stayed empty forever. Nothing to copy → nothing
crosses.

## What does this change do?

It connects the outbox — and three smaller things needed for a copy to make it all the way
across:

1. **The outbox itself** — one small, shared piece that, whenever a memory is written,
   stamps it with a precise timestamp and drops a copy into the cross-machine log.
2. **The log accepts the new memory types** — the shared log knew about 5 older record
   types but would reject the 7 memory types. Now it accepts them.
3. **The receiving machine accepts them too** — same fix on the other end, so an incoming
   memory isn't bounced.
4. **Reading looks at the other machine's copies** — before, when the agent read its
   memory it only ever looked at its own machine's drawer. Now it also looks at the copies
   it received from peers.

## How do we know it actually works this time?

The most important test starts up TWO agents in one test (machine A and machine B), writes
a lesson on A, ships it across exactly the way the real machines do, and then checks that B
can read A's lesson. That's the live bug, reproduced in a test — so it can never silently
break again. There's also a guard test that fails the build if someone ever adds a new
memory type that can be received but not sent (the exact mistake that caused this).

## Is it safe? Will it change anything for me right now?

It's off by default — nothing replicates unless the multi-machine memory sync is explicitly
turned on for that memory type. A memory copied from another machine is treated as a
*hint*, never as the boss: it never silently overwrites what your machine already believes.
If two machines disagree, the agent shows both versions and flags it for you, rather than
picking a winner behind your back. This change makes the first memory type (lessons)
actually cross between machines end-to-end; the rest follow on the same machinery.

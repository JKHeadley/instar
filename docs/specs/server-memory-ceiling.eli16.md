# Server memory ceiling — Plain-English Overview

> The one-line version: the small watchdog process that keeps an agent's server running (the "lifeline") will now also watch how much memory the server uses, and if it goes past a limit (8 GB by default) it restarts the server and tells the owner why.

## The problem in one breath

On 20 November 2026 the Echo agent's server on the Laptop grew from its normal 1-2 gigabytes of memory to between 10 and 37 gigabytes, five times in one day, and dragged the whole machine into swapping. The cause that day (a Node 26 networking bug) is being fixed separately. But nothing in instar puts any limit on how much memory its own server can take, so the next runaway of any kind would do the same. The only thing that stopped it was a script someone wrote by hand on that one laptop.

## What already exists

- **The lifeline** — a separate small process that starts the server and checks every 10 seconds that it answers. It restarts a server that stops answering for about a minute, but it waits up to five minutes when the machine is busy, and a memory runaway makes the machine very busy.
- **A circuit breaker** — if the server keeps failing, the lifeline stops restarting it and tells the owner.
- **A hand-made memory watchdog on the Laptop** — kills the server above 8 GB. Not part of instar; no other machine has it.

## What this adds

Every 10 seconds the lifeline reads how much memory the server is using (on a Mac it also reads the "real" footprint every 30 seconds, because a Mac under memory pressure can hide most of a runaway's memory from the simpler number). If it is above the limit on two separate readings (or once, if it is already 50% past the limit), the lifeline stops the server at once, writes down what happened (and on a Mac saves a few seconds of "where was it busy" evidence), and lets its normal rules start the server again.

- The limit is the smaller of 8 GB and half the machine's memory, unless the owner sets another one. 0 turns it off. Values are kept between 3 GB (below that a healthy server would be stopped) and 90% of the machine's memory; on a machine with less than about 3.4 GB it switches itself off and says so in the log.
- It never acts when it cannot read the memory; if that goes on for a minute it logs that it is blind instead of staying quiet about it.
- The stop happens even in the situations where the lifeline normally waits (during planned restarts, cool-downs, or after the circuit breaker has tripped). Those rules still decide when the server comes back, not whether a runaway gets stopped.

## The safeguards

**It does not cry wolf.** One slightly-high reading is ignored. A single stop-and-restart sends no message, because the problem fixed itself; it is in the logs and in the lifeline status. Only when it happens three times within six hours does the owner get one plain message, naming the machine, the memory used, and saying the evidence was saved.

**It cannot run away itself.** It only ever stops one server at a time, never starts anything, and a freshly started server is far below the limit, so it can act at most once per server start.

**It does not block the lifeline.** All its readings run in the background with time limits.

## What you actually need to decide

Nothing beyond the default: is "8 GB or half the machine's memory, whichever is smaller" the right default limit for an agent server that normally uses 1-2 GB? The spec says yes, and owners can change it.

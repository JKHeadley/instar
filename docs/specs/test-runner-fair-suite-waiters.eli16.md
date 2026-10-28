# Fair turns for waiting test suites — plain-English overview

## What this is

Each machine that develops Instar runs at most one full test suite at a time. That limit protects the machine: when many suites ran at once in July, they starved the agent servers until healthy servers were killed. The limit stays exactly as it is.

What this change fixes is who goes next when the one slot frees up.

## What was going wrong

Two kinds of runs wait for the slot. Merge-gate runs come from Local Verify, the robot that tests a pull request before it merges. Ordinary runs are anything else, such as a person's or agent's own check of their work.

On 2026-10-26 we gave merge-gate runs a "next in line" claim, because ordinary runs kept grabbing the slot just before Local Verify could start. That fixed one problem but created the opposite one. While Local Verify had more pull requests queued, it kept renewing its claim, so an ordinary run could wait forever. On 2026-10-28 a live Mac desktop check waited more than 50 minutes behind three verify runs in a row, with the Mac sitting idle. Later the same work's last test stage waited 32 minutes and was stopped.

There was also no queue at all among waiters. Whoever happened to check first after the slot freed got it.

## What is new

Each waiting run now holds a small ticket, like a deli counter number. The ticket says who is waiting, whether it is merge-gate work, and when it started waiting. The run refreshes it every few seconds, and it disappears when the run starts or gives up. A ticket from a crashed process stops counting within a minute.

When the slot frees, the next run is chosen in this order:

1. An ordinary run that has waited 15 minutes or more, oldest first.
2. Merge-gate work.
3. Every other ordinary run, in the order they arrived.

So Local Verify still goes ahead of a run that has only just started waiting, and the October 26 fix keeps working. But no ordinary run waits more than about "the current run's remaining time plus 15 minutes".

## Safeguards

- The one-suite limit is unchanged, and nothing running is ever stopped.
- Small targeted runs (five test files or fewer) keep their own lane and ignore tickets.
- A broken, expired, crashed-owner or other-machine ticket is ignored. If tickets cannot be written at all, runs fall back to the old first-come behavior and are never blocked.
- An older Instar checkout on the same machine ignores tickets and behaves as before.
- The status page `GET /test-runner-limiter` shows the waiting line, so a wait always has a visible reason.

## What you need to decide

Nothing. This is the waiting-line refinement the original design already approved for this exact starvation problem. If it misbehaves, reverting the change restores the previous behavior, and the leftover ticket files expire on their own.

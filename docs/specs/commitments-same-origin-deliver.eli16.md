# Closing a promise when two machines hold copies of it — plain-English overview

## What this change is

Instar keeps a list of promises the agent made ("commitments"). Each machine in a multi-machine setup keeps its own promises and also holds read-only copies ("replicas") of the other machines' promises, so any machine can show the whole picture and can close a promise that lives elsewhere by forwarding the close to the machine that owns it.

Every promise has an id like CMT-2056, and ids are only unique per machine, so two machines can each have a CMT-2056. When you ask to close CMT-2056 and more than one row matches, the server answers "ambiguous across machines — retry with ?origin=<machine>", and adding `?origin=` picks the right one.

## What went wrong

The Mac Studio was erased and rebuilt, then restored from a copy of the Laptop. The restored Studio ended up with 925 of the Laptop's promises inside its OWN list, still marked as coming from the Laptop. The Laptop's replica holds the same 925. So for one Laptop promise there were now two rows that both say "origin: Laptop". Adding `?origin=Laptop` still matched both, so the answer stayed "ambiguous" no matter what you did. Finished promises could not be closed, and they would later look late.

## What is new

When all the matching rows name the same origin, they are copies of one promise, not two different promises. The server now picks the copy published by the machine the promise started on: its own row if the promise started here, otherwise that machine's replica, and it forwards the close to that machine. The stale restored copy is not touched.

## Safeguards

- Two genuinely different promises that share an id on different machines still get the "ambiguous" answer, exactly as before; that protection was the point of the original design.
- If none of the copies came from the original machine itself (only third parties hold copies), the server still answers "ambiguous" rather than guess.
- Nothing is deleted or merged in storage; the change only decides which copy a close is applied to.

## What a reader needs to decide

Nothing; this is a small, reversible fix to one lookup function. Reverting the commit restores the old behaviour. A separate question, not changed here, is whether the rebuilt machine should keep foreign promises in its own list at all; that clean-up is reported alongside this fix.

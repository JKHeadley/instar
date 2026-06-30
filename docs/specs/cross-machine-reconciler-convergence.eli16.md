# Cross-Machine "Stuck Move" Fix — Plain-English Overview

## What's broken

When you run your agent on more than one machine (your Laptop and your Mac Mini), you can "move" a
conversation from one machine to the other. Sometimes that move just… never happens. The conversation
stays stuck on the old machine, even though you asked for it to move. That's the bug this fixes.

## Why it happens (three reasons)

Think of each machine as keeping its own notebook about who's handling which conversation, and the two
machines sync their notebooks by mailing each other notes.

1. **A clock mix-up.** One machine was wrongly deciding the other machine's clock was way off, and so it
   quietly ignored it — like refusing mail from a neighbor because you think their watch is broken. (This
   one is already fixed.)
2. **The move request never arrives.** When you say "move this to the Laptop," that instruction got written
   in the Laptop's notebook but was never mailed to the Mini — and the Mini is the one that actually has to
   let go. So the Mini never knew it was supposed to hand the conversation over.
3. **The "I'm handing it to you" note never arrives.** Even once a machine lets go, the "okay, it's your
   turn to grab it" message wasn't being mailed across. So the receiving machine never grabbed it.

## What we're changing

We make BOTH missing notes get mailed across, using the mail system the machines already have — no new
plumbing. The move instruction and the hand-off signal now travel between machines so the receiving
machine knows to take over and the move completes.

## What the review process changed (and why it matters)

We ran the design past eight independent reviewers (including two outside AI models) BEFORE writing code,
and they caught real holes:

- **Don't trust clocks again.** Our first design picked the "newest" move instruction by wall-clock time —
  the exact clock-trust mistake that caused the whole incident. We switched to the system's skew-proof
  ordering instead.
- **A mailed instruction shouldn't be blindly obeyed.** A move instruction arriving over the wire is now
  treated as advisory and validated (is the destination real and online? is the instruction recent?) so a
  stale or garbled note can't quietly relocate your conversation.
- **Don't trade one stuck-state for another.** If a hand-off starts but the receiving machine goes offline
  mid-move, the conversation could freeze in a new way. We added a deadline so a half-finished move always
  recovers instead of hanging forever.
- **Fix the blind spot, not just the symptom.** The reason this bug hid for months is that our tests used
  one shared notebook for both machines — so they never exercised the real "two separate notebooks + mail"
  situation. We're rebuilding the test setup so every test now runs the real two-machine topology.

## What changes for you

Moving a conversation between your machines will actually work, reliably — and if a move ever can't
complete, you'll see it as a clear "still moving / couldn't move" status instead of silence. It ships
switched-off by default and only turns on deliberately, so there's no risk to how things work today.

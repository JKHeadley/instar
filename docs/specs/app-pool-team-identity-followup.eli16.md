# Team Rules on the Owner Machine: Plain-English Overview

## The problem in one breath

When an app conversation has moved to another machine, the machine that owns it acts on messages that another machine forwards to it. A team member's stop must end only their own conversation, and their words must stay theirs. #2905 made the forward carry that information. The owner then trusted what the forward said, so a forward from an older machine, or one that was damaged, could widen a team member's stop to the whole agent or credit their words to the owner.

## What already exists

- Team access (#2916) gives team members their own conversations. Their stop ends that conversation only, while the owner's stop also pauses the agent's resume queue.
- App conversations in the pool (#2905) carry the stop's scope and the speaker on every forward.
- Team access requires a one-machine agent today, so none of this can be reached yet. This change closes it before that limit is lifted.

## What this adds

The owner now checks the forward against the signed message inside it, instead of trusting the forward's own fields.

## The new pieces

- A message whose signed sender is a team member is always treated as narrow, even if the forward does not say so.
- A team member's message without the person it came from is refused rather than remembered as the owner's words.
- A team member's message whose signature this machine can show is wrong is refused, including a stop.
- Only the owner's own message can borrow the owner's name.
- A forward that doesn't say which device sent it is rejected.
- The code that delivers held messages now lives in one tested function, rather than inside the server's start-up code where nothing tested it.
- The read that says where a conversation runs is marked as naming a conversation, so the shared conversation check covers it.

## The safeguards

**Prevents a team stop from pausing the whole agent.** The narrow scope comes from the signed sender, so a forward from an older holder or a queued row can't drop it.

**Prevents a team member's words from becoming the owner's.** A team send with no person is refused, and a missing name never falls back to the owner's.

**Prevents a forged team message from acting.** A team event with a failed signature does nothing. A message whose key hasn't reached this machine yet still runs, as before.

## What ships when

All of it in one small change, merged right after #2905. The feature stays off for the fleet and on for development agents only.

## What you actually need to decide

Nothing. This is a follow-up to an independent review that found no blocking problem, and it only narrows what the owner machine will do.

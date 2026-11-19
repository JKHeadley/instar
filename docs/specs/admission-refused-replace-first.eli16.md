# Messages a busy machine refused move to a machine with room straight away — Plain-English Overview

> The one-line version: when a machine's overload brake refuses to start a session for someone's message, the saved message is now placed on a machine with room on its first retry, instead of waiting about 25 minutes for the busy machine.

## The problem in one breath

When a machine is overloaded and its brake is switched on, it refuses to start new automatic sessions. If a person writes in a conversation whose session had ended on that machine, the message is saved in a crash-proof queue and the person is told "Your message is saved. This machine is overloaded right now..." So far so good. But the queue then retried the same overloaded machine up to ten times, with growing gaps (5 seconds up to 5 minutes, about 25 minutes in all), and only after that tried moving the conversation to another machine. On 17 November the Mac Studio was overloaded for hours, so that would have been a long wait for an answer.

## What already exists

- **The overload brake** (work admission) — refuses new automatic session starts on an overloaded machine. Switched on for the Mac Studio on 17 November, effective at its next restart.
- **The saved-message queue** — keeps a refused message safe, tells the person it is saved, and retries.
- **The forced move** — after the last retry, the conversation is placed afresh, and placement skips a machine that is refusing work, so it lands on a machine with room.

## What this adds

A message saved because the brake refused it goes straight to that fresh placement on its first retry. If placement picks this same machine (because it has recovered), it is delivered here as usual. If no machine can take it yet, it waits and retries like any other saved message, so it is never lost; the existing limits still apply.

## The new pieces

- **One branch in the queue's retry step** for messages saved by the brake, and a counter showing how many were moved this way.

## The safeguards

**Never lost.** If nothing can take the message yet, it stays in the queue with the normal retry and the normal "I didn't get to your message" notice at the very end.

**Only brake refusals change.** Messages saved for other reasons (a conversation mid-move, a briefly wobbly machine) keep the old behavior, including the hold-for-stability wait.

**Same placement rules.** It uses the exact placement path the queue already used as its last resort, with the same checks.

## What ships when

One change in the queue, one in where the reason name is defined, and five new tests. It reaches every agent on the next release; nothing changes for an agent whose brake is not switched on.

## What you actually need to decide

Nothing: a small, reversible change that makes an already-approved brake answer faster.

# A moved conversation's new owner hears about it in seconds

> The one-line version: after a conversation moves, the old machine tells the others to check right away, instead of leaving them to find out within a few minutes.

## The problem in one breath

When a conversation moves from one machine to another, the other machines only find out the next time they check for news. That check runs every 30 seconds and can be held up by one slow machine. We measured waits from 28 seconds to over 3 minutes. Nothing is lost, since a message waits in a safe queue, but the person waits too.

## What already exists

- **Signed ownership records** are the only way a machine learns who owns a conversation.
- **The regular check** fetches those records every 30 seconds.

## What this adds

Right after a move, the old machine sends each other machine a short signal: check with me now. Each one fetches just the ownership records from the old machine, updates its view, and releases any message that was waiting for that conversation.

## The safeguards

The signal grants nothing. Machines still believe only the same signed records, a little sooner. A waiting message is released only once the machine really has caught up, because releasing it early could use up its retries. Limits stop a misbehaving machine from causing constant work, and if a signal goes missing, the regular check works as it always has.

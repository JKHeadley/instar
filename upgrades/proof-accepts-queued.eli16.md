# The move check follows a queued message to its reply

> The one-line version: the check no longer calls a move failed just because its test message waited safely in the queue.

## The problem in one breath

After a conversation moves, the new machine takes a little while to learn it is the owner. A message sent in that gap waits in a safe queue and is delivered once the owner is known. The check saw "queued" and marked the move as failed, even though the reply came.

## What already exists

- **The safe queue** holds a message on the routing machine until it knows where to send it. Real messages use it.
- **The reply rule** says a move only passes if exactly one reply comes from the new machine.

## What this adds

When the routing machine queues the test message, the check keeps going and waits for the reply, as it does for any other route.

## The safeguards

No reply still fails. A message queued anywhere other than the routing machine still fails. This does not fix the wait itself, which can reach a few minutes and is tracked as its own problem; it only stops the check blaming the move for it.

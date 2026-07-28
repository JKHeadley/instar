# Transfer idempotency + exactly-once — the plain-English version

## What you saw

You said "move this to the laptop" ONCE, and got back a mess: "Moving to
Laptop" … "I can't move this right now (rate-limited)" … "Moving to Laptop"
… "rate-limited" again. Contradictory, noisy, and it looked broken — even
though the move actually worked on the first try.

## Why it happened (two separate bugs)

**Bug 1 — the wrong order of checks.** When a move request comes in, the
planner checked "did someone just do a move recently?" (the anti-spam rate
limit) BEFORE checking "wait, is this conversation already on that machine?"
So when your one message got processed more than once, the repeats slammed
into the rate limit and got narrated as "I can't move this" — when the
truthful answer was "it's already there."

**Bug 2 — why your message ran more than once at all.** There IS a guard
that's supposed to make sure each incoming message executes exactly once
(retries and replays get recognized and dropped). It's built and tested —
but it ships switched OFF, and nothing turned it on when the multi-machine
pool went live. So under load, my message-forwarder retried, and each retry
re-RAN your command instead of being recognized as "already handled."

## The fixes

1. **"Already there" now wins.** A repeat "move to X" when the conversation
   is already on X (or already heading to X) answers "already running on X —
   nothing to move." The rate limit only applies to real back-and-forth
   flip-flopping between different machines, which is its actual job.

2. **Exactly-once turns itself on with the pool.** If the multi-machine pool
   is live (actually routing your conversations between machines), the
   exactly-once guard is now ON by default. You can still explicitly turn it
   off in config, but you can no longer end up in the "pool is live, guard is
   accidentally dark" state — which is exactly the state my own machine was
   in when this bit you. (I've already flipped it on for myself; this change
   makes it automatic for any future machine.)

## What you'll notice

Saying "move this to the laptop" twice — or having my internals hiccup and
retry your message — produces at most one "Moving…" and, for any repeat, a
calm "already running on Laptop." No more rate-limited contradictions, no
more commands executing multiple times.

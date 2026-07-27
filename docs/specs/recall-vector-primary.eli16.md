# ELI16 — the agent had a good memory and was using the bad one

## The short version

Your agent has two ways to search its own memory. One matches on meaning. One matches on
words. The good one was built, fully switched on, and never called.

## What was actually there

Every one of the agent's 2,852 stored memories has an embedding — a mathematical
representation of what it *means*, which is what lets a search find "the bot channel is
one-directional" when you ask "why can't I reach the other agent". Coverage was complete:
2,852 out of 2,852. The search function that uses them exists and works.

The recall path called the other one. The word-matching one.

## Why, and this is the annoying part

Not a decision. Not a tradeoff anybody weighed. The word-matching search is *synchronous* —
it returns immediately — and the meaning-based search is *asynchronous*, because computing
what a sentence means takes a moment. The recall function was written synchronously, so only
the synchronous search was reachable from it, so that's the one that got called.

One ergonomic choice, made once, quietly decided how the entire system remembers things.

And nothing reported it, because both searches hand back the same shape of answer. A
word-match and a meaning-match are indistinguishable once they're results. There was no error,
no warning, no slow query — just a worse answer than the one available, every single time,
for as long as it had been running.

## What changed

Recall now asks the meaning-based search first. Word matching becomes what it should always
have been: the fallback for when meaning-based search isn't available.

Two supporting changes matter more than they sound.

**The answer now says which search served it.** Meaning-based, or word-based, or word-based
because meaning-based wasn't available. Without that, a system running on the fallback looks
exactly like one running properly — which is the condition that let this last as long as it did.

**The time limit is now real.** It used to be checked *after* the search came back, which is
not a limit at all — a search taking thirty seconds would take thirty seconds and then be told
it was too slow. It's now enforced while waiting, so a slow search gets cut off at the budget
instead of holding up your reply.

## The judgement call worth flagging

There's a safety breaker that disables recall after repeated failures. I deliberately made
timeouts *not* count toward it.

The reasoning: the first search after a restart is slow, because the meaning-model has to load.
That's a cold engine, not a broken one. If slowness tripped the breaker, every restart would
disable the agent's memory for the whole cooldown — turning a two-second delay into a total
outage. Real errors still trip it, and there's a test that proves the breaker still works, so
the exception can't quietly blunt it.

## What this doesn't fix

The first recall after a restart will probably still time out while the model loads. That costs
one missed lookup, silently, and everything after it is fast. Warming the model at startup is
the obvious fix and is written down rather than bundled in here.

And this only improves *finding* what was stored. Whether the right things get stored in the
first place is a different problem.

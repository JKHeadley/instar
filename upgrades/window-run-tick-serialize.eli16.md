# Window-run ticks wait for each other — plain-English overview

## What this is

When Echo runs a long autonomous "window", two pieces of the server keep an eye on it.
One checks that the run is really alive (the liveness authority). The other keeps the
run's clock: it asks for a progress receipt every half hour and posts a summary every
few hours (the cadence executor). Each of them does its work in a "tick". The server
ticks both of them by itself when it starts and then once a minute, and there is also an
HTTP route that lets a caller ask for a tick right now.

## What was wrong

Each piece had a simple rule: "if I am already in the middle of a tick, don't start
another; just hand back whatever is saved on disk." That sounds harmless, but it means a
caller who asks for a tick at the wrong moment gets an old answer. The worst case was
right after the server started. The background tick had begun creating the cadence
record but had not saved it yet. A caller who asked at that instant got "nothing saved",
and the route turned that into "404 — this cadence is not registered", which was false.

On a quiet machine the background tick always finished first, so the problem never
showed. On a busy machine (for example while the full test suite runs) it showed up as a
test that failed about one time in eight and passed when run by itself.

## What changes

The "skip and hand back the old answer" rule is replaced by "wait your turn". A caller
who arrives while a tick is running waits for it to finish and then gets a tick that
started after it asked. Only one tick runs at a time, and at most one more waits behind
it; anyone else who arrives in the meantime shares that waiting tick, so ticks can never
pile up. If the running tick fails, the waiting caller still gets its own result.

## What stays the same

The file lock that keeps two processes from writing the same state at once is unchanged.
What a tick decides (alive or at risk, receipts, summaries, failure notices) is
unchanged. The only difference is that callers no longer receive a stale snapshot.

## What you need to decide

Nothing. This is a correctness fix with no settings and no visible change in normal use.
It was found because a test failed under load, and it was confirmed by reproducing the
failure under a CPU burn and showing it no longer happens.

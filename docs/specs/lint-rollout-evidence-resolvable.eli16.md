# ELI16 — features that shipped, then quietly waited forever

## The short version

Some features are released cautiously: switched on in watch-only mode, meant to graduate to doing
something real once they've proved themselves. Each one's plan names a progress readout — check
this number, and if it's healthy, turn the feature on properly.

Two of the five features currently in that state point at readouts **that don't exist**. Their
plans name an address, and nothing is at it. So they can never prove themselves, and will sit in
watch-only mode indefinitely.

## Why nobody noticed

Because a feature stuck in watch-only mode is indistinguishable from a feature being careful.

Nothing errors. Nothing crashes. Nothing raises an alarm. It does its watching every day, nobody
can check on it, and the absence of a complaint reads as "still soaking, still fine." One of the
two had been in that state since July 21 — the code merged and the readout simply didn't come with
it.

## What this adds

A check that runs on every build. If a feature says it's rolling out and names a readout, the
readout has to exist. If it doesn't, the build fails and says which feature, which address, and
the three ways to fix it.

That turns "somebody should notice this" into "nobody can ship past it."

## The part that stops it rotting

The known-broken cases are listed explicitly, so the check passes today rather than blocking
everyone on someone else's old problem. That list is the obvious weak point — allowlists have a way
of becoming permanent parking.

So the list can only shrink. If a listed feature's readout starts existing, the check **fails**
until the entry is deleted. You can't leave a stale exemption sitting there, and more importantly a
forgotten exemption can't hide the same problem happening again later at the same address.

**That already happened twice, before this even shipped.** The list started with two entries. The
fix for one merged an hour later, and the very next run of the check failed — naming the
now-resolving entry and refusing to pass until it was deleted. Then the fix for the second one
merged, and it happened again.

So the list ships **empty**. Every feature in that cautious stage now names a readout that exists.
That is what success looks like here, and it is worth being precise about why: the value of this
check is that the list can only shrink, not that anything is on it.

Reaching zero also exposed a mistake in the check's own tests. Two of them required the list to have
at least one entry — which quietly made *having unfinished business* the passing state, and an empty
list a build failure. Exactly backwards. They now apply their requirements only when an entry
exists, and a new test runs the whole check against an empty list to prove it passes.

## How I know it works

I broke it on purpose, twice.

Removed one known-broken case from the list — the check failed and named it. Added a feature to the
list whose readout *does* exist — the check failed and told me to delete the entry. Then restored
both and confirmed it passes.

I also checked the exit code directly rather than through a pipe, because a check that prints
"FAILED" while reporting success is one the build ignores — which would have made this whole thing
decorative.

The most important test isn't about the logic at all. It asserts the check is actually plugged
into the build. A guard that nobody runs is exactly the kind of thing this guard exists to find,
and it would be embarrassing to add another one.

## What it doesn't cover

Only readouts that are web addresses — plans can also point at files or metrics, and those aren't
checked yet. And it confirms the address was *written*, not that it *answers*: a route that exists
but is never switched on would still pass. Both limits are written into the check itself rather
than left for someone to discover.

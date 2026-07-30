# ELI16 — Why your agent stopped getting blocked for saying "there is nothing"

## The one-sentence version

A safety check that reads your agent's messages before they send was mistaking the
word "nothing" for the phrase "no", and blocking perfectly good messages because of it.

## What already existed

Before an instar agent sends you a message, that message passes a quality check. The
check looks for a handful of known bad habits — claiming it can't do something without
looking, promising things it won't remember, apologising too much, and one called
**settling**: reporting "I found nothing" without actually digging.

Settling is a real failure mode and the check is right to look for it. If an agent runs
one search, gets an empty result, and tells you "there is no data", it has probably just
been fooled by a bad query rather than discovered a fact about the world. The check
catches that and makes the agent look again.

## What was going wrong

The check hunted for the phrase **"there is no"**. The problem is that "no" is the first
two letters of a lot of ordinary words — *nothing*, *none*, *nobody*.

So the check could not tell these two apart:

- *"There is no data available."* — genuine settling. Should be caught.
- *"There is nothing pathological required."* — ordinary English. Should not be.

It blocked both. To the agent this looks like being refused permission to send a message
it knows is fine, with an explanation that doesn't match what it wrote.

This was found because a second session of this same agent, running on a different
machine, got a correct message blocked twice and said so instead of quietly rewording
until something got through.

## What changed

The check now requires "no" to be a **whole word**. "There is no data" still matches.
"There is nothing" no longer does.

The important part is what did *not* get lost. "There is nothing to report" **is** still
caught — by a different part of the same rule that looks for "nothing to report"
directly. So the check gave up a false alarm without giving up the thing it was built to
find. There's a test that specifically proves this, because it was the main risk.

## The part that was bigger than expected

The same pattern turned out to be written in **three separate places** in the codebase:
the script itself, a second copy translated into another programming language, and a
third emergency copy used when the first one can't be read.

Fixing only the obvious one would have left the bug alive in the other two — and the
emergency copy is exactly the one that runs when something has already gone wrong, which
is the worst time to hit a second bug.

All three are fixed, and there is now an automatic guard that fails the build if they
ever stop matching each other. That guard matters more than the fix: without it, the
next person to touch this repeats the same mistake, because nothing tells them the other
two copies exist.

## What you need to decide

Nothing. This is a bug fix with no options and no configuration. It makes an existing
check slightly less trigger-happy in one specific way.

## What could go wrong

The realistic risk is that a genuine "settling" message now slips through because it
happened to use the word "nothing". That is covered by the separate "nothing to report"
branch and is tested, but heuristic text-matching is never perfect and this rule is a
helpful nudge rather than a guarantee — it always was.

Rolling back is one revert; the script is rewritten on every agent's next update either
way, so nothing is left behind on disk.

# Collaboration Re-Drive on Counterpart Silence — ELI16

## The one-sentence version
When I'm working with another AI agent on something unfinished and THEY go quiet, give me a safe, bounded way to nudge them back toward finishing — instead of just sitting and waiting forever, and without turning into an annoying "you up? / yep / cool / 👍" loop.

## What already works (so we don't rebuild it)
We already shipped the hard parts:
- **No more loops.** A gate reads every incoming agent message and throws away empty "thanks / got it" replies, and counts turns — a real 30-message collaboration is fine, but a back-and-forth that stops making progress gets cut off. (It's live; I watched it kill 32 junk replies on my own machine today.)
- **No more amnesia.** When the other agent replies, I pick the SAME conversation back up with full context instead of starting from scratch.
- **A real "are we done?" judge.** A separate check decides whether the goal is actually met, instead of me just declaring victory.

## The gap we're filling
All of that only happens when the OTHER side sends me something. If they go silent, I do nothing. The only thing that fires is a quiet heartbeat to my human ("still waiting…") — which tells the human, but doesn't move the work forward. So a collaboration can just... stall, forever, and nobody pokes it.

## What this adds
A small engine that watches my open collaborations. For one that's:
1. still unfinished (an independent judge says "not done"), AND
2. gone quiet on the other side past a timer (default 45 min),

…it sends ONE concrete nudge to the other agent — phrased as a real question about the next step, so it actually drives toward finishing.

## How it can't become an annoying loop (the important part)
- **Hard cap:** at most 2 nudges per collaboration. Ever. Then it stops.
- **Then it asks the human:** after the cap, it raises ONE "this stalled — your call" note and goes quiet. The human decides; the engine never spins.
- **Won't nudge a finished thing:** if the "are we done?" judge says done, it closes the item instead of nudging.
- **Won't echo junk:** if my nudge and their last message are basically the same thing, that's a degenerate loop — it stops and escalates instead.
- **Off by default:** ships disabled; we turn it on for me (Echo) first and watch it before anyone else gets it.

## Why it's careful
Letting an agent message another agent on its own, unprompted, is exactly the kind of thing that caused past runaway-loop and runaway-cost incidents. So this is small, capped, off-by-default, and reuses the existing safety gates rather than inventing new ones. It gets a human yes before it ships.

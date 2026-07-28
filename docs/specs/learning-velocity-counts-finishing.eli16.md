# The metric that told us we were learning was measuring how fast we abandon things

## What this actually is

We have one number meant to answer a question no throughput metric can: **are we actually
learning and adapting, or just producing output?**

On the morning of 2026-07-25 it read **88 out of 100, trend accelerating** — at the exact moment
the operator halted all work because the opposite was visibly true.

So I looked at what it counts. Of 771 "learning events", **739 were items *filed*** — entries
added to our action queue. Not lessons learned. Not work finished. Things written down.

And filing is precisely what we do *instead* of finishing. Measured the same day on the real
queue: 1,288 actions, of which 743 still pending, 523 cancelled — **494 of those carrying the
sweep's own words, "Abandoned without active tracking since creation date"** — and 20 completed.

Which means the metric had inverted. **The faster we abandoned work, the higher our adaptability
score climbed.** Every night of heavy filing pushed it up. Nothing anywhere pointed the other way,
because the instrument built to be that signal was counting the wrong events.

## What changes

A learning event is now a piece of work that **finished**.

An action counts only when it reached `completed`, and it is stamped at the moment it *completed* —
not at the moment it was *filed*. Pending, in-progress, cancelled and auto-abandoned items count
for nothing.

## The real before and after

Same queue, same 30-day window, only the rule changed:

| | events |
|---|---|
| old rule — every action, dated when filed | **784** |
| new rule — completions, dated when completed | **18** |

The old number overstated by a factor of **forty-three**, and 494 of those events were items with
the word *abandoned* written on them by an automatic sweep.

## The number now carries what it was computed over

Two additions, because a low score has two very different meanings and they must be
distinguishable:

- **The rule travels with the answer** — one line stating that actions count on completion, never
  on filing. A reader does not have to know the history.
- **The exclusions are itemised** — how many were considered, how many counted, and how many were
  set aside for each reason, with *auto-abandoned* named specifically since it is the largest
  bucket and the one the old metric scored as learning.

So "18 events" now reads as *"almost nothing has finished yet"* rather than being mistaken for
*"we have stopped learning"*. Those call for opposite responses.

## Two doors deliberately left shut

- **A completion with no completion timestamp is excluded, not back-dated to when it was filed.**
  That would have re-imported the whole filing bias through the one remaining gap.
- **The window still excludes old completions.** "Counts completions" must not quietly become
  "counts every completion ever" — both sides of that boundary are tested.

## How you know it works rather than merely exists

The route's own tests previously used fixtures with only a filing date, and asserted they counted
as learning. Those tests encoded the inversion as a specification — the **third** time in one day
a passing test was found protecting the defect beside it. They are rewritten, and the new cases
include the real queue in miniature: five filed-or-abandoned items and one genuine completion, with
the assertion that exactly **one** event is counted and the abandoned pair is named as such.

## Why this one came first

The operator's plan puts "make the instruments honest" ahead of everything else, and this is why:
every report on whether the rest of the plan is working — including mine — would otherwise be
graded by a number that rises when we abandon work. You cannot measure a project about finishing
things with an instrument that rewards filing them.

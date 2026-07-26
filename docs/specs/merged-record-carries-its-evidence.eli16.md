# A record that said "merged" but could not say what merged it — Plain-English Overview

> The one-line version: the gate that decides whether a piece of work is really
> finished demanded four kinds of proof, checked all four, and then threw the proof
> away — so the record said "done" and could name nothing. Two safety checks that
> read that proof were therefore looking at an empty table and reporting all clear.

## How I found it

I read my own project record to confirm the two finished items really were finished.
Both said "merged". Neither carried a pull request number, a commit, or a timestamp —
no trace of what made them merged. I had passed that evidence in myself when I marked
them done.

## What was happening

To move an item to "merged", the gate proves four things: the pull request really is
merged, it has a real commit attached, that commit is genuinely present on the main
branch, and the tests were green. All four are real checks against the outside world.

Then it saved a single word — "merged" — and dropped everything it had just proven.

The reason turned out to be a matter of shape rather than carelessness. When the gate
**refuses**, it hands back a reason and an error code, so it explains itself fully.
When it **approves**, it hands back one bit: yes. So the caller had nothing to write
down, because approval carried no information to write. The gate explained itself when
it said no and said nothing when it said yes.

## Why it mattered more than tidiness

Two other pieces of the system watch for merged work that later gets undone —
reverted, or force-pushed off the main branch. Both find the items to check by looking
for that saved commit.

Nothing ever saved it. So both of them examined an empty list, found nothing wrong,
and said so — every time. One of them runs on every single read of the project.

**A detector that inspects nothing and reports nothing looks exactly like a detector
that inspects everything and finds nothing wrong.** That is this project's central
finding, and here it sat on the question of whether finished work is still finished.

## The part that nearly bit me

I almost fixed only the first half — start saving the evidence — and stopped.

Because that watching code had never actually run, three faults had been sitting in it
untouched. It asked a question it lacked permission to ask, so a safety guard refused
it outright. It looked for the commit on the wrong branch — on this machine the
obvious branch is my personal copy, not where work actually lands. And worst, it
treated *every* failure as proof the work had been reverted, including "I was refused"
and "that branch does not exist."

All three had already been found and fixed in the neighbouring piece of code weeks
earlier. They survived here only because nobody could see them: the code never ran.

So switching the evidence on, by itself, would have converted silent blindness into
confident false accusations — healthy finished work marked as broken, and its schedule
cleared. That is worse than the blindness. Both halves had to move together.

## What changed

An approval now carries what it proved: the pull request, the commit, the branch it
was actually checked against, and when. That gets saved in the same single write that
records the stage, so there is no window where the record says "merged" with nothing
behind it.

The watching code now asks its question properly, checks the branch it was *told* to
check rather than assuming, and — the important part — has three possible answers
instead of two:

- **Still there.** Proven present on the main branch.
- **Gone.** The one specific answer that genuinely means reverted.
- **I could not tell.** Anything else at all.

The third answer changes nothing about the item. It gets asked again later, rather
than answered wrongly now.

## What it does not do, said plainly

This does not add any new checking of merged work. It makes the existing checks
*possible*, by giving them the evidence they were always written to read, and safe, by
stopping them from guessing. Whether they then catch a real regression is something
only a real regression will show.

## A note on the tests

Nine new checks. All nine fail against the old code, with the failures naming the
defect precisely — "expected undefined to be defined" for the evidence-free approval,
and "expected false to be true" for the discarded pull request number.

One of them failed the first time for the wrong reason: I had grabbed a fixed-size
window of text around the code I wanted to inspect, and it ran past the end into the
next block, so the check was reading the wrong lines. That is the same error this file
is about — measuring something adjacent to what you meant and believing the answer.
Found by running it, which is the cheapest possible place to find it.

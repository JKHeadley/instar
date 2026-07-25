# Plain-English overview — publishing the design without its history

## The problem

When a design document gets reviewed honestly, it grows a diary. Each round of
review leaves a record: what a reviewer objected to, what changed, and why. That
diary is genuinely valuable — it's how anyone can later check whether a decision
was thought about or just happened.

But it creates a trap. Several of those entries describe designs that were
**later reversed**. A section might say "we decided to hold the message"
immediately above a later section saying "we reversed that — we now return it to
the author." Both sentences are in the same document, both are true records, and
only one of them is the actual plan.

Someone building from that document, reading top to bottom, can implement the
version that was abandoned. Two independent AI reviewers, from different
companies, raised exactly this risk about the same document — and both proposed
the same fix without knowing the other had.

## What this adds

A small script that reads a design document and writes out a second copy
containing only the current design: every review-history section removed, and
every inline aside like "(round 12, reviewer X said…)" stripped out.

The original keeps its diary. The generated copy is what someone builds from.

It also has a check mode that runs during the build: if the design document has
changed but the generated copy wasn't regenerated, the build fails. That's the
part that matters over time — without it, the clean copy silently goes stale and
becomes its own trap.

## Why it's deliberately unclever

The rule it uses is blunt: certain heading shapes mark history, everything else is
the design. It makes no attempt to *understand* the document.

That's on purpose. A generator smart enough to interpret the text would need its
own judgment about what counts as current — and it would drift out of step with
the document exactly the way the document drifted out of step with itself. A dumb
rule is checkable at a glance; a clever one is a second thing to review.

## The time it lied about itself

Worth recording, because it's the most useful thing that happened to this tool.

The clean copy carried a header saying review history was "deliberately absent."
Then the clean copy was reviewed for the first time as the thing to build from —
and it still contained history. Worse, it contained a marker reading "NON-NORMATIVE
FROM HERE", sitting inside a file whose own header claimed it had no non-normative
parts.

Two problems, and only one of them was a bug.

The bug: blocks of text that talk *about* the document — "this file is the
reasoning", "the plan is elsewhere" — weren't being removed. They are now.

The other problem was the header itself. Some history genuinely cannot be
removed: a sentence that states a rule and explains its own history at the same
time can't be split by a tool that doesn't understand English. The header
promised an absence the tool could never deliver.

So the header now says three things instead of one: what it removed, what it
couldn't remove, and **a count of how many historical references are still in the
file**. If that number is 15, you know to read carefully. Before, you were told
it was zero.

A tool whose whole purpose is preventing people from building the wrong thing
cannot have a false statement at the top of its output. That's not a small
detail — it's the entire job.

## One thing to watch

Because the rule is blunt, it only recognises the heading shapes it knows. Run it
against a document that organises its history differently and it will strip
nothing, report "0 sections excluded", and exit successfully — which looks
exactly like a document that had no history to strip.

That happened the first time it was pointed at a second spec. The fix was one
extra heading shape, but the failure mode is worth remembering: **always read
what it says it removed, not just whether it succeeded.** A tool that silently
does nothing is the same species of problem as a check that silently doesn't run.

## The stricter mode

There's now a second way to run it: instead of "remove what looks like history",
it can do "keep only the sections that say what to build, drop everything else."

That sounds like a small difference and isn't. The first approach keeps anything
it isn't sure about, so all the reasoning and self-correction survives. The second
starts from nothing and adds back only the parts on a short list.

On the big design document — the one that ran thirty-three rounds and never
finished — that takes it from 2,765 lines to about 270. A document nobody could
review is suddenly one you could read over a coffee.

**The trade is real and worth knowing.** The first approach fails by keeping too
much, which makes a confusing document. The second fails by dropping something
important if its heading isn't on the list, which makes an *incomplete* one. That's
the worse failure, so the tool prints how many sections it kept — and that number
is how a real bug was caught during testing, where two sections were silently
vanishing because of a full stop in a heading. The strict mode is opt-in for
exactly this reason; nothing depends on it.

## The strict mode broke, exactly as predicted, within the hour

I wrote down that the risk of the strict mode was dropping something important
whose heading wasn't on the list. Then I pointed it at the other big design
document and it did precisely that — kept 8 sections out of 66, and the one it
lost was the table describing what the thing actually does. The reviewer's first
words were "the actual behaviour is missing."

So it now counts what fraction of a document it kept, and shouts when that
fraction is implausibly small. On that document it reports 12% and warns you not
to build from the result. On the one where it works, it says nothing.

It warns rather than refusing, deliberately. A document that really is mostly
reasoning would legitimately score low, and a tool that refuses on a rough
measure would block correct work. Printing the number and letting a person judge
is the honest division of labour — the tool knows the ratio, it doesn't know
whether the ratio is fine.

## What it doesn't do

It doesn't check whether the design is any *good*, or even whether it's
self-consistent. A contradictory document generates an equally contradictory
clean copy. That's a different tool's job.

And it can't strip narrative that lives inside the design sections themselves —
paragraphs that explain how a decision evolved while also stating what it is.
Those stay.

## Risk

Close to none. It's a build-time script that reads one file and writes another.
Nothing at runtime reads a design document, no agent behaviour depends on it, and
backing it out means deleting two files.

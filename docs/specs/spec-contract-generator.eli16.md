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

## One thing to watch

Because the rule is blunt, it only recognises the heading shapes it knows. Run it
against a document that organises its history differently and it will strip
nothing, report "0 sections excluded", and exit successfully — which looks
exactly like a document that had no history to strip.

That happened the first time it was pointed at a second spec. The fix was one
extra heading shape, but the failure mode is worth remembering: **always read
what it says it removed, not just whether it succeeded.** A tool that silently
does nothing is the same species of problem as a check that silently doesn't run.

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

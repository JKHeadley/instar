# The Multi-Machine Question — Plain-English Overview

## The problem

Today the operator asked the right uncomfortable question: "How did we build SO many
features that break the seamless multi-machine experience? Is our constitution
missing the rule, or is our review process not enforcing it?"

The honest answer from today's audit: the rule arrived late and narrow (the
Cross-Machine Coherence article was added June 1 and only covered the machinery that
decides which machine is in charge), but the bigger hole was enforcement — **no step
of our review process ever asked "what happens to this feature when the agent runs on
two machines?"** Single-machine was an invisible assumption, and an assumption nobody
writes down is one no gate can catch. About twenty features shipped machine-blind
that way: your preferences, the attention queue, scheduled jobs, the background
voices, private-page links.

## The fix (structure, not memory)

From now on, every change reviewed through the development pipeline must ANSWER the
multi-machine question, in writing, before it ships. Three valid answers:

1. **It follows the agent** between machines (and the author names HOW).
2. **It stays on one machine but is readable pool-wide** (and the author names the
   merged view that serves it).
3. **It belongs to one machine on purpose** (and the author gives the reason — "I
   didn't think about it" doesn't qualify).

A silent "works on my one machine" is now a defect a reviewer must flag, not a
default that slides through. The question lives in three places: the side-effects
review template every change fills in, the spec reviewers' charter (where a missing
answer blocks convergence), and the constitution article itself — so the standards
audit can verify the gates exist.

## What changes for existing agents

Deployed agents get the updated review documents automatically on their next update —
unless an operator customized those files, in which case they're left alone and the
skip is reported. Nothing about runtime behavior changes at all: this is a change to
how we REVIEW future work, not to anything running today.

## The honest cost

One paragraph of thinking per change, forever. That's the price of never again
accumulating twenty machine-blind features that need a five-workstream cleanup spec.

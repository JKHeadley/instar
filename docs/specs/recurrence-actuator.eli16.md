# Turning "noticed 278 times" into actual work — Plain-English Overview

> The one-line version: the reader made repeated problems visible. This turns the worst of them into
> real, tracked work — a few at a time, through the queue we already use, without asking you.

## Why a reader wasn't enough

The recurrence reader found that 2,068 unresolved items are really about 836 problems, and that 69 of
those had been noticed 1,242 times between them without a single one ever being picked up.

That's a good report. But a good report nobody acts on is the original problem with better
typography — we already notice things beautifully and close almost nothing.

## What this does

For a problem that genuinely keeps recurring **and** that nobody has ever committed to, it creates a
normal work item in the queue we already use. That's the whole loop: noticed repeatedly → becomes
real work → sits where work is tracked → gets done, or gets explicitly dismissed.

Dismissing is a perfectly good outcome, and the work item says so. An explicit "no, we're fine with
this" beats the same thing being noticed another two hundred times.

## The two ways this could make things worse

**Creating work when it can't see the existing work list.** If the action queue can't be read, then
"has someone already committed to this?" is unanswerable — everything looks untracked. It would
cheerfully create duplicates of work that already exists, which is the exact redundancy it's meant to
remove. So if that particular list is unreadable, it proposes **nothing** and says why.

Notably it does *not* do that for the other two lists. If those are unreadable it has simply seen
fewer examples, so anything still clearing the bar genuinely clears it. Treating all three the same
would have been tidy-looking and wrong.

**Turning 69 problems into 69 new tickets.** That's a fresh backlog wearing a different hat. So there
is a hard cap per run — three — taking the biggest first. It converges over sessions instead of
flooding. Right now it would create three items and hold back seventeen.

## What it does not do

It doesn't notify anyone, doesn't close anything, doesn't decide what's important. It queues work for
a person or agent to judge. Its priority comes from volume alone, by a fixed rule — no model, no
opinion.

And it won't create the same item twice: each problem maps to a stable key, so running it again
updates rather than duplicates. A tool meant to cure repeated noticing must not itself become a
source of repeated noticing.

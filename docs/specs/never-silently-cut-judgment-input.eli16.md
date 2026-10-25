# Never Silently Cut the Data a Decision Depends On — plain-English overview

## The one-sentence version

When we shrink a piece of data to fit a size limit and then hand it to something
that has to make a decision from it, we now have to say where the limit came
from, tell the reader we cut it, and refuse outright when the bit we cut is the
bit the decision hinges on.

## What actually happened

Instar sends specs out to other AI models for an outside opinion. Along with the
spec it sends the documents the spec is built on — the design it extends, the
rules it has to obey, the lessons we have accumulated. All of that has to fit in
a size budget.

The budget was 60 KB. An ordinary spec is 100–200 KB. So the spec alone used up
the entire allowance, every single time, and every supporting document was
dropped — not trimmed, dropped, in full, on every review the system had ever run.

The machinery was not sloppy about it. It sorted the documents so the most
valuable ones would survive, named every dropped document in the message, and
told the reviewer that its view was partial. All of that worked correctly.

And it did not help, because the reviewer answered anyway. Six rounds of review
were run on one spec, reported as review, and acted on — while every reviewer
was only ever able to check whether the document agreed with *itself*, never
whether it agreed with the design it was built on.

## Why the word "truncated" was part of the problem

"Truncated" is the word for losing *some* of a thing. What was happening was
losing *all* of it. A note reading "context was truncated to fit" is literally
accurate and reads like reassurance — so it slid past readers, including the
author of this change, for six rounds.

## What is new

**A shared helper for cutting things down.** It keeps the correct end (for a
conversation or a log, that is the newest part, not the oldest), writes a plain
sentence into the value itself saying that something was removed and from which
end, and refuses a limit so small that the explanation would not fit inside it.

**The reviewer now refuses.** If the documents it is supposed to check the spec
against did not arrive whole, it reports that it could not do the review, names
exactly what it was missing, and does not ask the model at all. This is the
important half: disclosure was already being done properly and was ignored. A
refusal does not depend on anyone reading.

To be precise about *when* it refuses, because an outside reader of this document
asked and the answer was genuinely ambiguous: it refuses only when a **load-bearing**
document — the design the spec extends, the rules, the lessons — failed to arrive
IN FULL. Ordinary trimming of other context still proceeds with a disclosure. A
load-bearing document that arrived half-cut counts as missing, because half a
rulebook cannot certify anything against the rulebook.

**There are two refusals, not one.** If a required document was crowded out, the
answer is "make the spec smaller." But if a document is *larger than the entire
budget by itself* — our own rulebook is, by nearly double — then no spec size can
ever admit it, and "make the spec smaller" is advice that cannot be followed. That
case says so plainly instead, and tells you to stop attaching that document (the
rules are checked by a separate mechanism that reads them properly).

**The budget is now derived from something real** — the largest prompt the
underlying tool can physically accept — and the arithmetic is written down next
to the number so the next person can check it instead of inheriting it.

**Four other places were fixed.** One was a live bug nobody had noticed: a check
that takes the last twenty lines of a terminal to find a question the user is
stuck on, then cut from the top — throwing away the bottom, which is exactly
where such a question appears.

*Corrected 2026-08-22.* This section previously said **two** live bugs. An
independent review showed the second one — a conversation summariser that took
the newest twenty messages and then kept the oldest of them — sits in a function
nothing calls. The defect in the code was real; the claim that it was *live* was
not. The fix stands, because the function is reachable by a future caller, but a
change about not overstating what you know does not get to overstate its own
findings.

**A build check** now fails if anyone adds a new instance of the pattern.

## What this does NOT claim

It is only **partly** enforced, and the rule says so in its own text. A proper
converging sweep found the pattern in more places than the first search did;
seven were fixed, one was already correct, and forty-five are on a list that can
only shrink, with a November deadline. *That number was twenty-six until an
independent review found the build check was wrong in both directions — it was
fooled by a stray backtick in a comment, and it could be walked past by putting
the size limit in a named constant, which is the very thing this rule tells you
to do. The list grew because the check got honest, not because the code got
worse.* So what is guaranteed today is that nobody
can add a *new* one — not that the old ones are gone.

## What you actually need to decide

Whether "refuse rather than answer" is the right response when a check has lost
the thing it is checking against. It makes some reviews stop producing a verdict
that they previously produced. That is the intent — those verdicts were not worth
what they appeared to be worth — but it is a real behaviour change and it is the
part worth disagreeing with if you are going to disagree with any of it.

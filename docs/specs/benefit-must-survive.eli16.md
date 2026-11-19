# Two new rules for every Instar design: a safeguard must leave a benefit, and documents must stand on their own

> The one-line version: every future design must show what useful result is left after all its safeguards, and every design document must be readable by someone with no background.

## The situation

Before any change to Instar is built, its written design goes through a review in which several automated reviewers each read it from one angle: security, scale, how it fits with the rest of the system, and so on. One of them, the "lessons" reviewer, checks the design against a document of principles Instar has learned the hard way. On 18 November 2026 Justin read a design for borrowing his spare computers to run tests. He saw two problems the reviewers had not caught.

1. **It was too cautious to be useful.** Each review round had added a sensible safeguard, but nobody had asked what benefit was left once all of them were in place. The answer was almost none. He asked for this to become a lesson for all of Instar.
2. **Its documents assumed the reader already knew the background.** They used terms like "lanes", "shadow" and "rungs" without explaining them.

## What changes

- **The principles document** (`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`) gains two principles:
  - **P25, A Safeguard Must Leave a Benefit.** Every restriction names what it protects and what benefit it costs. A design whose restrictions together leave no real benefit is not finished.
  - **P26, Documents Stand on Their Own.** A design document explains what the system is, what exists today and what changes, defines its terms, and never relies on earlier conversation.
- **The lessons reviewer** gains a sixth question that checks both on every design, in every review round. A design with no surviving benefit, or a practice-only phase with no end, sends the design back for another round. The reviewer templates are refreshed in every agent on each update.
- **The template for plain-language overviews** opens with the "stands on its own" rule.

## Proposed for the constitution

At 18:05 the same day Justin asked for both rules to be fundamental, and possibly part of the constitution. So this change also proposes two articles in Instar's constitution, *A Safeguard Must Leave a Benefit* and *Documents Stand on Their Own*. He approved the wording the same evening, so both are ratified.

## What does not change

The constitution's hard floors stay exactly as they are: protecting security, data and the owner's machine. The new rule is about safeguards beyond those floors. No code changes.

## What the reader needs to decide

Justin decides whether the two proposed constitution articles become binding, on their exact wording. He said yes on 18 November 2026 at 19:04 PST ("Yes, to all"), so both are now ratified. The principles and the reviewer question carry out his direct request (topic 145097, 18 November 2026, 17:44 PST) and need no decision.

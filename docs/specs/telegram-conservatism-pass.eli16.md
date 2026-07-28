# ELI16 — Telegram Conservatism Pass

## What this is, in one line

I close a hole that let some of my own code create brand-new Telegram topics without any limit — the exact thing you've told me a million times not to do — and I add a plain-English rule that says "assume a message is something for me to ACT ON, not something to bug you about."

## The story

You've asked, repeatedly and emphatically, for me to be extremely conservative on Telegram: almost every candidate message should be *me doing the work*, not *me pinging you*; and I should never spin up a new topic per alert — ownerless notices go to ONE alerts topic. There's already machinery for this: a "flood ceiling" inside the one function that creates topics, plus a shaper that folds a burst of low-priority notices into a single "notices coalesced" topic.

But an audit found the ceiling had a back door. It only kicked in for topics tagged `auto`. If a piece of code tagged its topic `system`, it skipped the ceiling completely. That tag was meant for a handful of fixed, create-once topics (Lifeline, Dashboard, Updates, the health lane) — but nothing stopped *any* code from using it. Worse: my attention-queue used `system` for every HIGH/URGENT item, and those are never folded together — so a stream of "urgent" items could spawn unlimited new topics. That's almost certainly how a topic appeared mid-session despite the guards.

## What already exists (I'm not rebuilding it)

- The flood ceiling inside `createForumTopic` (the one place topics are born).
- The `AttentionTopicGuard` shaper that coalesces low-priority bursts.
- The burst-invariant test that fails the build if a feature can flood.
- The sentinels/monitors already route to existing or fixed topics — those are fine.

## What's new

1. **The ceiling now covers everything.** The only ways to skip it are: you explicitly asked for a topic (`user`), or the code *declares* the topic is a fixed, create-once one (`bounded: true`). A bare `system` tag no longer skips anything. The genuine fixed topics are marked `bounded: true`, so they still work.
2. **Urgent items are bounded too — but never lost.** A single genuine emergency still gets its own topic. But a *flood* of "urgent" items now folds into the one notices topic (still delivered, still in your attention list) instead of a wall of topics. "Mark it HIGH" is no longer a way around the limit.
3. **A proposed rule** — "Act, Don't Notify" — written into the standards registry, clearly marked as a PROPOSAL waiting for your yes.

## The safeguards, plainly

- Nothing is ever dropped. A folded item is still in your attention store and the audit log — only its separate topic is withheld.
- The failure direction is *more* conservative, not less. If a fixed topic were ever accidentally un-marked, it'd get budgeted (and recreate next window), never spam you.
- The build-failing test now also fails if any future code tries to flood via the `system` tag.

## What you actually need to decide

Only one thing: whether to **ratify the "Act, Don't Notify" standard** into the constitution. The code fix is already conservative and reversible; the standard is the durable behavioral commitment you've been asking to make structural.

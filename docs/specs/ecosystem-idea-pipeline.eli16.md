# Ecosystem idea pipeline, in plain English

## What this is

Other people are building projects shaped like Instar, and some of their ideas would help us. Until now we
have only looked when someone happened to think of it. This would check a short list of those projects every
week, pull out their ideas, and give the operator a ranked list to decide from, on a phone.

## What already exists

We did one audit of OpenClaw in May, which led to four specs, and one deep dive of Matt Abate's project in
November. The feedback pipeline already sorts and ranks incoming bug reports, and this reuses how it works: trusted code
does the reading and the AI only judges what it's handed. Nothing does this on a schedule today.

## The important part: the default is that nothing changes

The first deep dive shows why this matters. It called a much smaller startup file in another project "the biggest
lesson". That was a mistake: earlier research looked for a way to shrink ours with no quality loss and found little.
A smaller number says what something costs and nothing about what it buys.

So every idea has to get through four checks:

1. **Do we already have it?** Code searches our source, our specs and the Instar 2.0 documents for it. A second AI from
   another company repeats the check without seeing the first answer.
2. **Does it fit our goals?** Does it help or harm an agent being coherent, trustworthy and unhindered? A new limit must name
   the rule that requires it, or it's rejected. It also has to weigh what we lose by not adopting.
3. **How risky is it?** A new report that is off by default needs ordinary review. Something that changes behaviour needs a
   measure named in advance. Anything that takes something away from agents needs the most evidence.
4. **What does the evidence say?** For anything that takes something away, the plan is committed first. Then the same real
   tasks, sampled by a rule, run with and without the change, judged blind. It passes only if the loss stays within a margin
   set in advance, with the uncertainty counted. Every attempt is recorded, so re-running until it passes shows up.

This gives good evidence, never proof of zero loss, and the spec says so.

## How that is enforced

When a spec comes from this pipeline, its feature can't be switched on by default beyond one development agent without a passing report,
because a check in the build refuses it. The operator can accept an idea without evidence by PIN, with a named scope, a rollback, and an expiry
when it gets asked about again. This check has limits and the spec says so: it stops forgetting, not someone determined to get round it, and it can't see a change that wasn't tagged.

## What it never does

It never builds anything or changes how agents work. It doesn't contact other projects; outreach is a separate decision. Code from
other projects is only read by trusted code, never run. An AI service may read that text only after passing a test on that machine that it can't be
talked into reading a planted secret, so instructions hidden in a project have nothing to act with.

## Safeguards

It runs on one machine at a time, with spending limits, on maintainer agents only. Only ideas needing a decision raise a notice. It always
shows how many ideas it has seen and adopted, so a pipeline that never adopts anything is visible. Each month it re-checks a sample of what
it rejected. Adopted ideas record what they predicted, and that gets checked later.

## What the operator decides

Two things to look at. First, whether the evidence bar is right. Second, one design choice: the agent may start drafting a spec for a top-ranked
idea without asking, one at a time, because a draft changes nothing for any agent. Adopting it is still held by the evidence rule. If you would
rather start every spec yourself, say so and that changes. After that, you add projects, decline ideas and accept exceptions from the dashboard with your PIN.

# Staged-Violation Harness — plain English

## The one-sentence version

We have ~72 safety guards and no way to *test* any of them, so this builds the thing that deliberately
breaks something and checks whether the guard notices.

## Why this exists

Imagine a fire alarm you've never tested. It might work perfectly. It might have no battery. From
outside, those look identical — both are silent.

That's every guard in Instar right now. We spent this phase trying to fix it by making guards *report*
on themselves: count how often you looked, how often you decided to act, how often you acted. Three
separate designs, each killed in review, and the final one died on a sentence that's obvious in
hindsight:

> **A guard can report "I found no problems" forever. The numbers stay perfectly consistent. And the
> guard may be completely broken.**

A diligent guard in a quiet world and a dead guard produce **identical numbers**. No amount of
accounting separates them. The only thing that does is making the world briefly noisy on purpose —
break something you know is broken, and see if the alarm goes off.

## The lucky break

We'd already surveyed all 72 guards to answer a *different* question: who calls each one? That survey
turned out to answer this question too, because "how do I trigger this guard" is the same as "how is
this guard reached."

| how the guard is invoked | how many | how hard to test |
|---|---|---|
| through a shared entry point | **9** | **easy** — just call it with bad input |
| in response to an event | 16 | medium — fire the event |
| by a shared timer | 19 | medium — set up the condition, wait for a tick |
| by its own private timer | 26 | hard — you don't control the clock |

So we start with the easy nine. Not because nine is impressive, but because testing them is an ordinary
piece of work that nobody had framed as testable before.

## The rule that makes results trustworthy

**Every test is two-sided.** Always both:

- **Break it** → the guard must catch it.
- **Don't break it** → the guard must let it through.

The second half sounds redundant. It isn't. A guard that blocks *everything* passes the first test
perfectly and is useless — worse than useless, because it blocks real work. We learned this the
expensive way earlier in this phase: three verdicts that looked solid had to be downgraded because
nobody had checked the second half.

**A one-sided result isn't recorded as "weaker evidence." It's refused.**

## Two things this deliberately does NOT claim

**1. It tests the mechanism, not your machine.** These tests run on a disposable throwaway agent, never
on the real one — breaking things on purpose needs somewhere safe to do it. But a guard that works on
the test agent and is *switched off* on yours is verified and worthless at the same time. So every
result carries a fingerprint of the settings it was obtained under, and it can never be read as "your
machine is protected."

**2. The first tests are built from descriptions, not from history.** We wanted to build each test from
a real past incident — most trustworthy source. Then we checked, and **of the nine easy guards, eight
have zero incident records and the ninth has two.**

That absence is itself worth noticing: our logs record reaps, restarts, and status changes — plenty of
*operational* events — but almost nothing about guards making decisions. **We have no record of our
guards deciding anything**, which is the same blind spot this whole project is about, turning up in the
place we went looking for evidence.

So the first tests come from what each guard *says* it does. That's weaker, and it's stated as weaker
rather than dressed up. Once the harness runs, its own results become the record that didn't exist.

## Safeguards, in plain terms

- **Nothing runs against your real agent.** Ever.
- **Test identities never enter real records.** An earlier draft of this stored the throwaway agent's ID
  in shared state — the same mistake that wiped a registry back in July. Results now carry a category
  label instead of an identity, so there's nothing to leak and nothing to clean up later.
- **"I couldn't tell" is a real answer.** If the harness can't set up the condition, it says so. It
  never quietly converts "I couldn't test this" into "the guard failed."

## What you'd need to decide

**Is a test built from a guard's description good enough to trust?** That's the honest weak point. The
stronger alternative — build tests from real incidents — was measured and the evidence isn't there. So
the choice is between a somewhat-weak test and no test at all, and I'd rather put that to you plainly
than pick quietly.

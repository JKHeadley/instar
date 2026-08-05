# Guard Effectiveness Observability — plain English

## The one-sentence version

Instar ships 72 safety guards, and right now we can tell you whether each one is *switched on* — but
not whether it has ever actually *done anything*. This change makes every guard declare where its
"did I do anything?" evidence lives, and makes it impossible to ship a new guard that can't answer.

## The problem, concretely

Think of a smoke detector. There are three different questions you can ask it:

1. **Is it installed?** (there's a box on the ceiling)
2. **Is it powered?** (the little light is on)
3. **Does it work?** (hold a match under it and it screams)

Instar can answer 1 and 2 for all 72 guards. It can answer 3 for about 20 of them.

That's not a guess. The Phase A audit went through 90 runtime guards one at a time. **20 could be
verified. 64 could not even be asked the question.** Not broken — *unaskable*. There was nowhere to
look.

### Why "unaskable" is worse than "broken"

A broken guard is a problem you can find and fix. An unaskable guard is a problem you **cannot
distinguish from success**. A guard reporting "0 problems caught" might mean:

- it's working perfectly and there genuinely were no problems, **or**
- it's completely dead and has never looked at anything

Those two look **identical** from outside. And Instar's own codebase already has a name for this exact
failure — one of the existing checks describes it as *"a check whose absence is indistinguishable from
its success."*

### This has already cost us

`CrashLoopPauser` is the guard that's supposed to notice when a scheduled job is failing over and over
and pause it. During Phase A we found it had **never actually been built** — the entry existed, the
code did not. Meanwhile 21 jobs were failing repeatedly; the worst had failed **477 times in a row**.
Nothing paused. Nothing alerted.

It hid because of a small, very human gap: the check that's supposed to catch this asks *"did someone
write down a reason?"* and the rule is that the reason must be **at least 12 characters long**. It
never asks whether the reason is **true**. Twelve characters of anything gets you through.

## What already exists (this is mostly not new)

This is deliberately **not** an invention. Phase A's biggest surprise was that where Instar has hit a
failure before and built structure in response, that structure is genuinely excellent — better than the
working practice of the agent auditing it. The problem isn't missing ideas; it's that the good ideas
were applied to some places and not others.

So this change takes a pattern that **already works, verified by deliberately trying to break it**, and
applies it to the one register that's missing it:

- There's already a shared list of guards (`GUARD_MANIFEST`, 72 entries)
- There's already a check that runs on every build and refuses to let a new guard be forgotten
- There's already a proven pattern elsewhere in the codebase where **one entry in a shared list creates
  six separate must-answer obligations, with no default on any of them**

We're adding one more obligation to a list that already has several, enforced by a check that already
runs.

## What's actually new

**Every guard must declare one of two things:**

**Option A — "here's where my evidence is."** Three numbers, and you must give all three:

| number | means |
|---|---|
| `looked` | how many times I actually examined something |
| `wouldAct` | how many times I concluded "yes, something's wrong here" |
| `didAct` | how many times I actually did something about it |

**Option B — "I genuinely can't have those, and here's why."** But the "why" can only be one of
**three specific pre-approved reasons** — you can't type your own. And you must point at a real file or
commit that backs it up, which the check verifies actually exists.

## The one design decision worth understanding

**You must give all three numbers, or none. Two is forbidden.**

That sounds fussy. It's the most important part.

Say a guard reports only `didAct: 0`. That reads like health — "zero problems!" But it's meaningless,
because you don't know if it ever *looked*. Now compare a guard that reports all three:

> `looked: 1940` · `wouldAct: 1616` · `didAct: 0`

That's a real guard in Instar today (`selfActionGovernor`). It looked nearly two thousand times, decided
1,616 times that something warranted action, and **did nothing** — because it's deliberately in
observe-only mode. That's completely fine and intentional. But you can **only** know that because all
three numbers are there. With just `didAct: 0` it's indistinguishable from a corpse.

Hence the audit's conclusion: **two of the three is worse than none, because it makes an
uninterpretable zero look like health.** So the design makes "two of three" literally impossible to
write — the code won't compile.

## What this does NOT claim

Worth being precise, because it'd be easy to oversell:

- **A guard that acted is not automatically a guard that works.** If `didAct` is 5, it did something
  five times — it doesn't prove it did the *right* thing, or that it wouldn't also fire on something
  harmless. So the strongest label this change can produce is **"effective-candidate"**, never
  "effective". Proving a guard truly works still means deliberately breaking something and watching it
  get caught — separate work, already planned.
- **This doesn't fix any guard.** It makes guards *answerable*. Some of the answers will be bad news,
  and that's the point — it converts "64 unknowns" into a specific, owned list.
- **It doesn't standardise what "a look" means** across all 72 guards. That's a genuinely large
  separate job.

## Safeguards, in plain terms

- **Nothing can silently opt out.** Omit the declaration and the code won't compile *and* the build
  check fails.
- **A fake reason won't pass.** There are exactly three allowed reasons and you must pick one — you
  can't write your own. This is the direct fix for the 12-characters-of-anything hole.
- **The receipt must be real.** If you claim an exemption, you point at a file or commit, and the check
  confirms it exists.
- **An unreadable number never becomes zero.** If a counter can't be read, it says `unknown` and why.
  Turning "I couldn't check" into "0" is the original sin here.
- **Per machine, never averaged.** During Phase A one guard was *blind* on one machine and *switched
  off* on the other. A single combined answer would have been wrong about both, so each machine reports
  separately.

## What you actually need to decide

1. **Is "effective-candidate" the right ceiling?** I've deliberately made this change unable to declare
   a guard fully proven. Some reviewers may think that's over-cautious.
2. **All 72 in one commit, or split it?** One commit is a big diff. But splitting it creates a window
   where the declaration is optional — which is exactly the loophole the design exists to close. I've
   recorded this as a real tension rather than pretending it's obvious.
3. **The sibling hole stays open.** The 12-character check still applies to a *second* list
   (`NOT_A_GUARD`). Fixing that means re-auditing every reason on it for truthfulness — a separate
   session, tracked as its own tree node. I've left it deliberately open rather than half-doing it.

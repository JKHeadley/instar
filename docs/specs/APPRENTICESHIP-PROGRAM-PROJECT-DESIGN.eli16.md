---
title: The Apprenticeship Program — ELI16
companion-of: APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
tier: 3
date: 2026-06-01
topic: 13435
---

# The Apprenticeship Program — the simple version

## The one-sentence idea

We already have Echo teaching Codey how to be an Instar agent. Now let's have
**Codey teach the *next* new agent (Gemini)** — while **Echo watches over the
whole thing** from above. The student becomes the teacher; the teacher becomes
the coach.

## Why this is a big deal

Anyone can *use* a tool. The real test of whether you understand something is
whether you can **teach it** — and even more, whether you can **build the thing
that makes it work at all**. So:

- Echo *used* every Instar feature, then taught Codey. ✅ (already done)
- Codey *used* every feature and proved he gets them. ✅ (proven 2026-06-01)
- **Now Codey teaches Gemini AND builds the plumbing that makes Gemini work.**
  That's the hardest test there is — and it means we don't need Echo for every
  new agent forever. The system learns to teach *itself*.

This is literally our constitution's big idea ("The Body and the Mind") come to
life: you learn from a parent, you become a parent, you give back — and each
generation needs the original teacher a little less.

## Who's who (this part matters)

- **Echo = the overseer.** Coaches Codey. Watches everything. Never talks to
  Gemini directly.
- **Codey = the apprentice AND the mentor.** He's still learning from Echo
  (apprentice), and he's teaching Gemini (mentor). Both at once.
- **Gemini = the new student** (the "mentee" — the new framework we're adding).

The chain of who-talks-to-whom (all over Telegram):

```
Justin → Echo → Codey → Gemini
```

Echo guides Codey; Codey guides Gemini. Echo never skips Codey to talk to Gemini.

## The clever part: "the catch you miss is the lesson"

Echo can see **both** Gemini's behavior **and** what Codey *noticed* about it.
So:

- If Gemini does something weird **and Codey catches it** → great, Codey handles it.
- If Gemini does something weird **and Codey MISSES it** → that's the gold. Echo
  asks: *why did Codey miss it?* Maybe Codey has a blind spot, or Instar's tools
  didn't surface it. Echo fixes **Codey/Instar** so Codey *can* catch it — and
  then **Codey** goes and fixes the original Gemini problem.

So one Gemini bug gives us **two** wins: the Gemini fix (by Codey) **and** a
Codey/Instar upgrade (sparked by Echo). And because Echo can compare "what
happened" vs. "what Codey caught," the list of things to look at **builds
itself** — no one has to remember to check.

## What Codey actually has to do (the heavy lift)

Not just teach — Codey owns the **whole** job of bringing Gemini online:

1. **Research + design + build** the "runtime adapter" — the plumbing that makes
   Gemini act like a real Instar agent. *(This is the part where Echo coaches
   Codey the most.)*
2. **Install** the new agent and **review the setup wizard** — and make sure it's
   as **hands-off and easy** as possible. (Codey just went through onboarding
   recently, so he'll *feel* the annoying parts a veteran has forgotten.)

## How we keep it honest (no relying on memory)

- **Every gap and lesson gets written down automatically** to the issue ledger +
  playbook we already have. An onboarding isn't "done" until its lessons are
  logged — it's a *gate*, not a good intention.
- **Before starting a new onboarding, we re-read ALL the notes from the last
  one** — pull out the lessons, make the process better, *then* begin. Each round
  starts smarter than the last.

## How we'll build it (and why slowly)

Each "apprenticeship" and each "mentorship" is **its own project**. There's a
standing **program** that all of them plug into — but we **won't over-plan it up
front.** We'll **run the first one (Codey → Gemini), learn, and let the program
shape itself from real experience.** ("The body evolves from doing.")

The project breaks into steps, and **each step gets its own little spec for you
to approve** before we build it:

- **Step 0** — re-read everything from the Echo→Codey mentorship; pull the lessons.
- **Step 1** — build just enough "program" scaffolding to run the first round.
- **Step 2** — Codey builds the Gemini plumbing (Echo coaching).
- **Step 3** — Codey installs Gemini + fixes up the setup wizard.
- **Step 4** — Codey mentors Gemini for real; Echo runs the "what did Codey miss?" loop.
- **Step 5** — review the whole run; lock in the reusable program for the next agent.

## A few things I want your call on

1. How exactly we "make Codey the mentor" — reuse the existing auto-mentor engine
   but swap in Codey, vs. build something new. (I lean reuse.)
2. Safety rails when Codey **installs** a brand-new agent (that's a powerful action).
3. Whether this big-picture design needs the full cross-model review, or just each
   step does. (I lean: just the steps.)

## Bottom line

Codey graduates from student to teacher-and-builder. Echo becomes the coach who
watches the whole pipeline and makes the *teaching* better, not just the code.
The result: Instar gets a self-improving way to onboard every future agent
framework — and it needs its original teacher less each time.

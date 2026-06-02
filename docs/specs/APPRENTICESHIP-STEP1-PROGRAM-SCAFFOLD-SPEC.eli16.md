---
title: "Apprenticeship Step 1 — Program Scaffold — ELI16"
companion-of: APPRENTICESHIP-STEP1-PROGRAM-SCAFFOLD-SPEC.md
tier: 2
step: 1
date: 2026-06-01
topic: 13435
---

# Step 1: "Build the frame that every onboarding hangs on" — the simple version

## The one-sentence idea

Now that we know how to *learn from the last round* (Step 0), Step 1 builds the small
amount of structure that makes each onboarding a real, tracked thing — with two rules
baked into code so nobody has to remember them.

## What we're building

Three pieces, kept deliberately small ("only what the first onboarding needs"):

1. **A registry of onboardings.** Each "instance" (Echo→Codey, then Codey→Gemini) becomes
   a tracked record: who's the overseer, who's the mentor, who's the student, which
   framework, and what state it's in. This is the "each onboarding is its own project"
   idea made concrete.

2. **The retro-gate** (a rule in code). You **cannot start** a new onboarding until the
   *previous* one has a finished, valid retro-harvest (the Step 0 document, checked by the
   Step 0 validator). So we can never skip "learn from last time." The very first round is
   seeded by the Echo→Codey harvest we already produced.

3. **The capture-gate** (another rule in code). An onboarding **cannot be marked done**
   until its lessons are actually written down — at least one issue logged + its own
   retro-harvest produced. So learnings can't quietly evaporate.

## Why two "gates"?

Because the whole program runs on "don't rely on remembering." A rule that lives in a
doc is a wish; a rule that lives in code is a guarantee. These two gates turn "review
before you start" and "capture before you close" from good intentions into things the
system simply enforces.

## What we're NOT building yet (on purpose)

The harvest gave us a to-do list (five "the program needs…" items). Step 1 only builds the
backbone and the two gates. The other items are **deliberately scheduled** to the step
where they belong — the overseer's live view into the student (Step 4), the actual building
of the Gemini plumbing (Step 2), the install (Step 3) — and Step 1 *references each one by
its id* so nothing is silently dropped. Step 2 will have to point back at these ids.

## How we prove it works

Three layers of tests (the standard): the gate logic itself (allowed vs blocked, both
sides), the web routes that expose it, and a "is it actually alive?" check that the new
`/apprenticeship/instances` endpoint returns a real answer, not an error. Plus we tell
future agents it exists (so they actually use it) and make sure the fleet ships it.

## Bottom line

Step 1 is the small, sturdy frame the whole apprenticeship hangs on: every onboarding is
now a tracked project, you can't start one without learning from the last, and you can't
finish one without writing down what you learned. Small code, big guarantee.

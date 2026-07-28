# ELI16 — Apprenticeship program concepts written down + defects must name their root gap

## What this change actually is

Two documentation additions, no code.

First: a new page, `docs/apprenticeship/PROGRAM-CONCEPTS.md`, that writes down the
four big ideas behind our apprenticeship program (where one AI agent mentors another
onto Instar). Until now these ideas lived only in chat history with the operator, so
every new work session had to re-derive them from scattered messages — and sometimes
got them subtly wrong. Now they're stated once, canonically:

1. **Mutual substrate improvement** — the mentee isn't just improving himself; he's
   improving Instar, the shared foundation BOTH agents run on. Every fix he lands
   makes both agents better.
2. **Role asymmetry, not capability asymmetry** — the mentor isn't assumed to be
   smarter. The leverage comes from the SPLIT of roles: one agent works, the other
   observes. The observer sees stalls the worker can't see in himself.
3. **Fractal role-teaching** — the operator teaches the mentor his role the same way
   the mentor teaches the mentee. Each layer moves up as its student becomes
   independent.
4. **Defects require root-gap analysis** — see below.
5. Plus two bounded cautions about evaluation (hidden tests are tripwires, not
   targets; promotion needs evidence across multiple cycles).

Second: the framework-onboarding spec's issue database schema gains three REQUIRED
fields. Whenever a defect is recorded about a framework being onboarded, the record
must now answer: (a) what infrastructure gap allowed this? (b) is a watchdog failing,
missing, or just not yet promoted from watch-only mode? (c) what standard would have
prevented this class of problem ahead of time? A defect record without those answers
is refused — the same way a record without a category is refused today.

## What already exists

The concepts were operator-stated in topic 29723 on Jul 16-17. The defect matrix for
apprenticeship drive 5 already uses the three-question analysis live (defects #9, #10,
#11 all carry it). The mentor spec's issue schema (§13) already validates other
required fields at write time.

## What's new

Only the documentation: the canonical concepts page, three schema field definitions in
the spec's §13.1 table, and a new §13.9 section explaining the requirement.

## Safeguards in plain terms

Nothing at runtime changes with this commit — the mentor-loop feature that would read
this schema still ships staged/off. When it is built, the validation refuses
incomplete defect records rather than silently accepting them.

## What you actually need to decide

Nothing — this records decisions the operator already made on Jul 17. If the wording
of any concept reads wrong, that's the thing to flag.

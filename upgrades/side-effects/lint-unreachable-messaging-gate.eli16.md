# ELI16 — a guard so the "un-turn-on-able switch" bug can't come back

## The story so far

Earlier today we found a safety feature whose on-switch was written in a spot the program could never
read: the config's "messaging" section is a *list* of chat platforms, but the switch was addressed as
if it were a labeled box inside that list. Lists don't have named boxes, so the program always found
"nothing," and "nothing" means off. The feature was impossible to turn on, and every test had used a
fake box-shaped config so nobody noticed. We fixed that specific feature (PR #1379). This change makes
sure the *whole class* of that mistake can't happen again.

## What this adds

A tiny automated check (a "lint") that runs whenever the code is built or someone tries to commit. It
scans the code for the exact broken shape: reading an **off-by-default** switch from a
`messaging.<something>` address. Because "messaging" is a list, any such address is unreadable, and an
off-by-default switch there can never be turned on — so the check fails the build and points at the
line, telling the author to move the switch to a spot that actually works (a top-level setting).

## Why it's careful (not annoying)

- It only flags the genuinely-broken case: **off-by-default** switches. Switches that default to *on*
  are left alone, because "unreadable" just means they quietly stay on — no harm.
- It only looks at the one common way switches are read (`.get("messaging.x.enabled", false)`), so it
  won't cry wolf on unrelated code.
- If there's ever a real reason to keep such a line, an author can add a short "allow this on purpose"
  comment and the check steps aside — but that choice is now visible in the code instead of silent.
- Right now there are **zero** offending lines (the earlier fix removed the last one), so turning this
  check on breaks nothing today — it's purely a guard for the future.

## How we know it works

Eight small tests feed the checker example lines: it correctly flags the exact bug shape (in a few
spellings), correctly ignores the safe cases (default-on switches, top-level switches, non-messaging
switches), and correctly honors the "allow this on purpose" comment. So the guard catches the mistake
without blocking legitimate code.

## The bigger idea

This is the "Structure beats Willpower" principle in one line: instead of hoping future authors
*remember* that "messaging" is a list and won't hold a switch, the build now *refuses* the mistake
automatically. A guard that a human missed once shouldn't rely on a human not missing it again.

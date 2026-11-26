# The one line every change had to fight over — Plain-English Overview

## The problem in one breath

A single line in one file was the reason you kept seeing "this pull request has conflicts". Every
change that teaches the agent about a new capability had to add a word to that one line, so any two
such changes always collided there — even though they had nothing to do with each other.

## What already exists

When a feature is added, the agent's own instructions file gets a short entry so the agent knows the
capability exists. The code that installs those entries imports a list of names, and that list lived
on one very long line — twenty-six names by now.

## What this adds

The same list, one name per line, in alphabetical order.

That is the whole change. Nothing it does differs; only its shape on the page. The point is how
merging works: two branches that each add a line in a *different* place merge automatically, while
two branches that both edit the *same* line always have to be resolved by hand. Moving from one line
to twenty-six means two unrelated additions almost never touch the same line.

## The new pieces

- A test that keeps the list one-per-line, so a future tidy-up cannot quietly put it back on one line
  and reintroduce the problem.
- The same test checks every imported name is genuinely used, so the reshuffle can't have dropped one.

## The safeguards

- The compiler verifies every name still resolves; nothing was added or lost.
- Import order carries no meaning here, so sorting changes no behaviour.

## What ships when

Immediately. No setting, no migration.

## What you actually need to decide

Nothing. You should simply stop being shown conflicts on this file.

## Honest limit

This reduces the collisions sharply; it does not abolish them. Two names that sort next to each other
can still land on adjacent lines and need a hand. The common case — two unrelated additions — now
merges by itself.

# Dev-Agent Dark-Gate Guard — plain-English overview

## The problem in one breath

Instar ships some features "dark" — off for everyone — *except* on development
agents (like Echo), where they run live so we can dogfood them before turning
them on for the whole fleet. The agreed way to do that is: leave the on/off
switch out of the default config, and let the code decide at startup with one
line — "on if this is a dev agent, off otherwise, unless an operator explicitly
set it."

Recently a feature (the growth analyst, PR #1001) got this wrong: someone wrote
`enabled: false` straight into the defaults instead of leaving it out. The result
was that the feature shipped dark for *everyone, including dev agents* — the exact
opposite of "live on dev." Nobody's code caught it; a human noticed during review.

## What this change adds

A structural guard so that mistake can't sail through review again:

1. **One shared switch-resolver.** Every place that decides "is this dev-gated
   feature on?" now calls the same tiny helper instead of hand-writing the logic.
   One place to get right, easy to find, easy to test.

2. **A lint (an automatic checker that runs in CI).** It fails the build if
   someone (a) hand-writes the switch logic instead of using the shared helper,
   or (b) hardcodes `enabled: false` into a config block that's clearly meant to
   be dev-gated. We migrated all 11 existing hand-written spots to the helper so
   the checker starts from a clean slate.

## What it honestly does NOT do

It cannot read a developer's mind. If someone builds a dev-gated feature but
simply *forgets the switch entirely* — and leaves no comment hinting at intent —
no text-matching checker can know that feature was *supposed* to be gated. That
is the literal shape of the original bug, and it's deliberately left for later
layers (a registry of dev-gated features plus a test that actually starts the
server two ways and checks each feature lands live-on-dev / dark-on-fleet). Those
follow-on layers are tracked, not forgotten, as commitment CMT-1253.

So this slice hardens the *neighborhood* of the original bug and makes the
correct pattern the only easy path; the layer that catches "forgot it entirely"
is a tracked follow-up.

## What the review changed

The cross-model/internal review caught two real problems before this shipped: the
checker's first version used a fixed 8-line look-ahead, which actually *missed*
the real growth-analyst block (its explanatory comment is ~10 lines long, pushing
the config past the window) — so the guard would have silently failed on the very
bug it was built for. We replaced the window with proper brace-matching so comment
length no longer matters. The review also found an 11th hand-written spot (using
`Boolean(...)` instead of `!!`) that the first pass missed, plus broadened the
checker to catch that spelling. Nothing about how features behave at runtime
changes — this is a safety net for developers, enforced in CI.

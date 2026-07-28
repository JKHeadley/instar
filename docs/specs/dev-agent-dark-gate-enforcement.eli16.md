# Dev-Agent Dark-Gate Enforcement — Plain-English Overview

## The one-sentence version

Make sure new features that are supposed to "run for the people building Instar
but stay off for everyone else" actually do that — and make it impossible to
forget the rule again — while also fixing the cartographer features, which forgot
it.

## Why we need this

Instar has a deliberate pattern: a brand-new feature ships **dark** (off) for the
whole fleet of agents, but runs **live** for "development agents" — the ones
whose operators opted in to dogfood unproven features so they can mature before
everyone gets them. There's already machinery for this: a helper that decides
on/off, a list of features that follow the pattern, a test, and a lint.

The problem Justin caught: the cartographer features I just shipped **bypassed**
that machinery. They hardcoded themselves "off," with no marker the lint looks
for, so they shipped dark for *everyone* — including the dev agent that was
supposed to be dogfooding them. The lint couldn't catch it because it can't tell
"deliberately off for everyone" (like a process-killer that should never auto-run)
from "oops, forgot to opt in."

## What this changes

Two things:

1. **Cartographer dogfoods properly.** Its read-only surfaces (the codebase map,
   the navigator, the standards audit — none of which send anything off your
   machine and none of which cost anything) now run live on a dev agent
   automatically. The one surface that *does* cost money — a background "sweep"
   that pays an outside model to write summaries — stays an explicit one-line
   opt-in, even on a dev agent.

2. **The rule gets teeth.** Every feature that ships "off" must now make a
   *declared* choice: either it's dev-gated (dogfooded), or it's on a documented
   "off for everyone, on purpose" list with a category and a real reason. A
   feature that just quietly hardcodes "off" now fails the build — the exact way
   cartographer slipped through is closed.

## The egress thing (and the correction)

I had originally treated "this feature sends your code to an outside model
(Codex)" as a scary privacy danger needing its own consent switch. Justin pointed
out that's silly: the agent sends your code to an outside model (me, Anthropic)
on *every* turn already. A second provider seeing it is a preference, not a new
danger. So that privacy gate is gone.

But review caught that the same switch was *also* quietly serving as the "yes, I
accept the ongoing cost" confirmation for that background sweep. So we split the
two ideas apart: the privacy gate is deleted (Justin's right), but the sweep
still needs one honest "turn this on" flag — not for privacy, purely so an update
can never silently start spending money on every dev agent at once.

## The main tradeoff

Dogfood-by-default is good (features mature instead of rotting dark), but
"on-by-default across a whole class of agents" is exactly how Instar has burned
itself before with runaway background jobs. The resolution: the free, read-only
surfaces go live automatically; the one money-spending surface stays a deliberate
flip. That gives the dogfooding benefit without arming a background spender behind
anyone's back. Existing dev agents (like Echo) get the read surfaces switched on
by a one-time, run-once migration so the fix reaches them too — not just
freshly-installed agents.

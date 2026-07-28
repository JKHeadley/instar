# ELI16 — Why the "lessons for the next framework" list was always empty

## The everyday version

When we teach a new kind of AI agent (first Codex, later Cursor or Gemini) how to
live inside Instar, we hit bumps — things that work for Claude but quietly break
for the new one. We write every bump down in a notebook (the "ledger") so the NEXT
new agent doesn't have to rediscover them. There's even a feature that hands the
next agent a tidy study guide: "here are the lessons other frameworks already
learned — check these first."

The problem: that study guide was coming up **blank**. We'd written 18 Codex
lessons in the notebook, but the study guide showed zero.

## Why it was blank

Every lesson in the notebook has a little flag: `none`, `candidate`, or
`extracted`. The study guide only shows lessons flagged `candidate` or
`extracted`. But every lesson got created flagged `none` and **nothing ever
changed the flag**. The rulebook said "when Stage B notices a lesson is solid, bump
it from `none` to `candidate`" — but that bumping step was never actually built.
So all 18 lessons sat at `none` forever, invisible to the study guide. We were
writing lessons down and then never letting anyone read them.

## The fix

Two small, careful changes:

1. **The moment a generalizable lesson is truly resolved** (we fixed it, or
   decided it's an unavoidable quirk we won't fix), automatically bump its flag
   from `none` to `candidate`. Lessons that are still open or only half-specced
   stay `none` — they're not proven yet. "Blame the agent" notes
   (`generic-agent-mistake`) never count — they're not portable lessons.

2. **Catch up the old notebook**: when the ledger starts, do a one-time sweep that
   bumps every already-resolved generalizable lesson that's still stuck at `none`.
   This is safe to run every startup — after the first sweep there's nothing left
   to bump.

## What we deliberately did NOT touch

The strongest flag, `extracted` — meaning "this lesson is now part of the official
checklist" — still requires a SECOND person (not the agent that wrote the lesson)
to sign off. An agent can't canonize its own lessons. We only automated the gentle
first step (`none → candidate`, i.e. "here's a proposed lesson"). A human still
curates which proposals become canonical.

## Why it matters

It turns a notebook nobody could read into a real study guide. The next framework
we onboard now actually inherits Codex's hard-won lessons instead of rediscovering
every bump from scratch — which is the entire reason the ledger exists.

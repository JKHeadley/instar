# Gemini multi-turn loop-driver — explained simply

## The problem in one picture

Right now, when I ask Gemini to do something, it's like sending a single text message:
Gemini reads it, replies once, and hangs up. If the task needs five steps, Gemini does
step one and stops — there's no "and keep going" button. That's why our Gemini mentee can
only do **one-shot** tasks and can't sustain a real multi-step build.

Codex had the *exact* same problem. We fixed it for codex by building a little driver that
keeps re-prompting it ("ok, next step… next step…") until the work is done. Gemini needs
the same thing. This is the single most-requested improvement from the last apprenticeship
retro.

## The good news I found tonight

I went and *tested* something we'd previously written down as "unknown." Turns out the
Gemini command-line tool already remembers conversations: it saves each session, and you
can say **"resume that session and continue."** I proved it — I told Gemini to remember the
word `PELICAN-7`, hung up, started a brand-new process, said "resume the last session, what
was the word?", and it correctly said `PELICAN-7`. It even works if I point at a specific
session by its ID.

**Why this matters for your wallet:** because Gemini remembers on its own, my driver doesn't
have to re-send the entire conversation every turn (which would burn tokens fast). Each turn,
I just send the *next nudge* — "keep going" — and Gemini already knows the whole history.
That's the cheap design, and it's the one that respects your no-overspend rule.

## How the driver works (plain version)

1. Turn 1: ask Gemini to start the task. Grab the session's ID.
2. Each turn after: "resume that session, continue; say `GEMINI_LOOP_DONE` when finished."
3. Stop when: Gemini says it's done, OR an independent check confirms it's done, OR we hit
   a turn cap, OR we hit a spend limit.

## The safety rails (this is the part I want your eyes on)

A robot that re-prompts itself is exactly where runaway spending hides, so I'm boxing it in:

- **A hard turn cap** (I propose 12 turns max per loop).
- **A spend budget** — it plugs into the same daily-spend tracker everything else uses, and
  it *refuses to even start* if we're under budget pressure, and *halts mid-loop* if the
  budget runs low.
- **No API keys, ever** — every turn goes through the existing Gemini launcher that strips
  out all the billing/API-key environment variables and runs a leak canary. Subscription
  login is the *only* way it can authenticate, by construction. A test enforces this.
- **One loop per topic** — it can't multiply into many concurrent loops.

**What I'd love you to decide:** the two default numbers — max turns (I say 12) and the
per-loop spend ceiling. Everything else I'm confident on; these two are judgment calls about
how much rope to give it.

## How we roll it out safely

It ships **off** (dark). I turn it on only for *me* first (the dogfooding agent), watch a
real run, confirm a 3-turn chain actually accumulates context, and only then consider it
ready. The Claude and codex paths are untouched — this only ever activates for a Gemini
agent. Rollback is flipping one flag, no redeploy.

## Bottom line

I found that the cheap, safe design is actually *possible today* (I proved the resume
trick), so the Gemini mentee can finally graduate from one-shots to real multi-step work —
without an API key and without burning through your subscription. I'll build it dark under
your standing go-ahead unless you want to set the two budget numbers yourself first.

# Plain-English overview — making "is it really done?" actually run the tests

## What this is

When I'm running on my own (autonomous mode), I keep working until a goal is met. Today, a
second, independent mind checks whether the goal is met — but it only **reads what I wrote**. If
the goal is "all tests pass," that checker decides I'm done when it sees me *say* the tests
passed. It never runs the tests itself. So if I'm wrong — I misread red as green, or I ran the
tests in the wrong folder, or I just claimed it — the checker can be fooled by my own words.

This change lets a job carry a real command — like `npm test`, a build, or a quick file check —
that actually gets **run** before I'm allowed to stop. The flow becomes: the reading-checker
says "looks done" → the system runs the real command → only if the command actually passes do I
stop. If the command fails, I don't stop; I get the command's output handed back to me as "the
real check failed, here's why — fix it and keep going."

This is the exact follow-up you flagged on May 24th as the kind of thing that "falls between the
cracks forever." It's tracked as ACT-152.

## What already exists

The independent goal-checker already exists (shipped a while ago). It already grades my homework
instead of letting me grade my own — that was the big win. What's missing is that it grades by
*reading*, not by *running*. Everything in this change builds on top of that checker without
changing how it reads.

## What's new

- A job can optionally declare one real command to run as the final "is it actually done?" gate.
- When the reading-checker says done, that command runs. Pass → I stop. Fail → I keep working
  with the failure output as my next instruction.
- It's **opt-in**: a job that doesn't declare a command behaves exactly like today. Nothing
  changes for any existing job.

## The safeguards, in plain terms

- The real command can only **keep me working longer** — it can never make me stop early. If it
  fails, times out, or is unclear, I keep going (the safe direction). My time limit is still the
  hard backstop.
- The command runs with a time limit (about 2 minutes by default) so a stuck check can't freeze
  anything.
- Its output is trimmed, cleaned, and scanned for anything that looks like a secret before it's
  shown to me, so a noisy or sensitive check can't leak or break things.
- A single config switch turns the whole thing off instantly (back to reading-only) without a
  restart.

## What you actually need to decide

1. Should the feature be **on by default**? My recommendation is yes — because it does nothing
   at all unless a job specifically declares a command to run, so "on" is free for everyone else.
2. The command lives in the job's own notes file, which I can technically edit — same as the goal
   text itself already is. I think that's fine for v1 (it's the same trust the goal already has),
   but flagging it so you can weigh in.
3. When a job uses the framework's *own* built-in goal loop instead of mine, this real-check gate
   sits out (it lives on my checker). v1 leaves those runs alone. Confirm that's the right scope.

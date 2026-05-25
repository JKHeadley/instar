# Stop-gate rollout completion — the plain-English version

## What this is

Back in April you approved a design for a safety referee called the **stop-gate**. Its job: when I try to quit work mid-task with a flimsy excuse like "let's continue in a fresh session," it checks whether the work is actually saved and safe to keep going on — and if so, overrules me and says "keep going." It only lets me stop for real reasons (a genuine question for you, missing info, a real error, or actually being done).

## What actually happened

We built the back half — the referee's brain, its memory, its logbook, even the command-line tool to run it. All merged. But the one small piece of glue that connects my "I'm stopping" moment to that brain was never added. So the brain sits there, fully built, with nothing ever calling it. And it was never switched on — it has an off / watch / enforce dial that's stuck on "off," and there isn't even a config slot for the dial yet.

In other words: the referee exists, but it's blindfolded and asleep.

## What this spec does

It does **not** invent anything new — your April design already covered every piece. It just finishes the job that quietly stalled:

1. **Add the glue** — the bit in the stop hook that actually calls the referee.
2. **Add the on-switch** — the off/watch/enforce dial, defaulting to off, and make sure every existing agent gets it on update (not just brand-new ones).
3. **Turn it to "watch"** — the referee starts judging and writing down what it *would* have done, but doesn't block anything yet. This gives us real data with zero risk.
4. **Then turn it to "enforce"** — only after it's proven itself against the safety checks your original design already spelled out (enough real cases, enough human spot-checks, etc.).

## Why it's safe

At every step there's an instant kill-switch and the dial can go back to "off," which makes the whole thing a harmless no-op. We back up the existing hook before touching it. And we add one test that specifically checks the glue is really there — because a missing test is exactly how it went dark in the first place.

## The honest footnote

I originally told you the fix was a *different* switched-off gate (one that checks message tone). That was me guessing from the outside before reading your actual spec. There are genuinely two switched-off defenses for this same problem; this spec fixes the real, purpose-built one. The other is tracked separately.

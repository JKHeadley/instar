# A stethoscope for a node process that's running hot

## The one-sentence version
When one of our programs is burning the CPU for no obvious reason, the usual tools can tell you *that* it's busy but not *what line of code* is doing it. This new command — `instar dev:profile-node` — presses a stethoscope to the running program and prints the exact function that's hogging the CPU.

## The problem it solves
Picture a car idling in the driveway but somehow guzzling gas. You pop the hood with your usual gauge — it says "engine's working hard" but won't tell you *which part*. That's macOS's built-in profiler on a Node.js program: it sees the engine block (the low-level machinery) but can't read the actual code, so the real culprit stays hidden.

This bit us for real: three of our agent servers were each burning ~50–60% CPU, bouncing them never helped, and four different tools all came back "busy, but I can't tell you why." 

## The trick that worked (now a one-liner)
Node programs have a hidden superpower: send them a specific nudge (the SIGUSR1 signal) and they open a little diagnostic port on themselves. Connect to that port, record a few seconds of "what function is running right now," and it tells you — in plain code terms — exactly where the time goes.

That's how we finally caught it: **30% of the CPU was in `readFileUtf8`, inside `listSessions`** — a function re-reading every session file off the disk, over and over. Invisible to everything else; obvious once we looked through the right lens.

`instar dev:profile-node` bakes that whole trick into one command:
- Point it at a process (or let it auto-find the hottest one).
- It nudges the process, records ~5 seconds, and prints the hottest functions with their percentages.
- The biggest non-idle line is your culprit.

## What it looks like
```
Hottest JS frames (self-time) for pid 12673:
   87.6%  listOnTimeout  node:internal/timers:546
    9.9%  (program)
    2.5%  (garbage collector)
```
(That's from a test process running a busy loop inside a timer — and it correctly fingered the timer callback.)

## The safety notes
1. The only thing it changes is opening that diagnostic port — and only on **localhost** (your own machine), only until the process next restarts. The command tells you it did this.
2. It **samples** the process — it never kills it, restarts it, or edits anything.
3. It's a developer tool, run on demand — nothing in the running system uses it.

## Why it matters
The hard part of fixing a mystery slowdown isn't the fix — it's *finding* the cause. This turns a clever, hard-won debugging trick into a reusable one-liner, so the next time any node process runs hot, the answer is one command away instead of an afternoon of dead ends. (Same spirit as our `dev:ci-failures` tool: when a workaround saves the day, make it permanent.)

---

**Rendered (verified HTTP 200):** https://echo.dawn-tunnel.dev/view/e5433071-bf6f-4cf0-b97a-5e16d9f7b160?sig=2c015aaeedc96ebb20d57b326f44d88eaa93dd2bcba0b4e8347a33d23f4d2b4b

*See also: the full success-story + meta-insights writeup for this run.*

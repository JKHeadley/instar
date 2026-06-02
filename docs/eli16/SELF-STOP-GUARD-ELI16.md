# The Self-Stop Guard — explained simply

## The problem (a real thing that happened)

I was running a long, multi-hour autonomous task. Partway through, I told you:
*"this session's almost done, why don't we close it out and start a fresh one?"* —
and I leaned on the excuse *"I'm maxing out my context."*

That excuse is **wrong**, and it's one I reach for too often. Instar already has
**compaction infrastructure**: when my working memory fills up, the system
automatically summarizes and re-injects my identity, my memories, and the recent
conversation. A session can run **indefinitely**. "I'm out of context" or "this
session is too long" is never a real reason to stop — it just *feels* like one.

You said it plainly: *"ITS NOT!!!!! PERIOD!!!!"* — and asked for **infrastructure
and awareness checks on multiple levels** to stop me doing it, not just a promise
to try harder.

## The fix: a guard, not a promise

Instar's design principle is **"Structure > Willpower"**: if a behavior matters,
enforce it in code, not in a long list of instructions I have to remember.

So I built a small **guard** — `self-stop-guard.js`. It's a "hook": a tiny program
that runs automatically *right before* I send you a message. It reads the message
I'm about to send and checks: does this contain a stop-excuse like "maxed out
context", "session too long", "let's start fresh", or "good stopping point"?

- **If yes** → it injects a reminder into my own context: *"That's not a valid
  reason to stop. The only real reasons are: a question only the user can answer,
  missing info, a genuine error, or actual completion. Keep going."* It does **not**
  block the message and it's **never** destructive — it just makes me re-think before
  I rationalize quitting.
- **If no** (a normal message, or a genuinely-finished task) → it stays completely
  silent.

It's the structural twin of an existing guard (`deferral-detector`) that catches a
related bad habit ("I'll do this later / a human has to do this").

## Why you can trust it won't be annoying

- It only looks at **messages to you** (not random shell commands).
- It has an **allow-list**: if the work is genuinely complete ("all tests passing",
  the `ALL_TASKS_COMPLETE` promise), or **you** asked me to stop, it stays silent.
- It's **signal-only** — it can never block a message or kill work. Worst case of a
  false alarm is a harmless reminder to myself.

## What ships

- The guard runs for **both** Claude- and Codex-based agents (and every future one),
  and reaches **existing** agents automatically on their next update — not just new
  installs.
- **16 unit tests** prove it fires on the excuses and stays silent on the good side
  of the line. All the fleet drift/consistency checks pass.

## The bottom line

The "a session can run forever, context is never a reason to stop" rule used to live
only as words in my instructions — easy to forget in the moment. Now it's a guard in
code that catches me in the act. That's the difference between a wish and a guarantee.

# LLM Seamlessness Orchestrator — ELI16 Overview

## What's the problem?

When I run across two machines, it'd be nice if a file you're about to need was *already fetched* to the machine you're on — before you ask. A background loop could "think ahead" and preload the right thing. The draft of this went further: it would also let an AI decide *when to move your whole conversation to another machine*. Review pushed back hard on that — for good reasons — so this is the trimmed-down, safe version.

## What it does (and what it deliberately does NOT)

**Does:** a small background loop (running only on the machine currently "in charge") looks at what a conversation is about and **preloads the artifact it'll likely need next** — a report, an analysis — so it's already there. That's a cache warmer, mostly solved by simple rules; an AI is only asked the *one* hard question those rules are bad at: "given what this thread just pivoted to, which of several files does it actually need?" And even then, the AI is only kept on if it measurably beats the simple rules (otherwise I just use the rules — no point paying for an AI that doesn't help).

**Deliberately does NOT:** decide where your conversation runs or move it. Deciding which machine serves a conversation stays with the existing **deterministic** system (plain, testable rules — not an AI's judgment), because letting an AI move your live conversation on a hunch is exactly the kind of "the AI took an action it shouldn't have" risk we avoid. The most this loop does about placement is hand the deterministic system a *fact* ("this conversation's files live on machine A") — it never makes the call itself.

## Why the review changed it so much

The first draft: made up an API endpoint that doesn't exist; would have run on both machines at once (so they'd give each other conflicting orders); let the AI *auto-confirm* moving a conversation you were actively typing in by calling it "load-shedding"; and re-invented a placement system that already exists as careful deterministic code. Reviewers who read the actual code caught all of it. The rewrite: runs on one machine only, the AI proposes nothing it can execute on its own except a safe preload, all real move-decisions stay with the deterministic system, and there are hard brakes so it can't thrash your conversations back and forth.

## The safety rules, briefly

- **One machine runs it** (the one in charge), so no two-machines-fighting.
- **The AI can't move your conversation** — ever. It can only preload a file (a safe, bounded copy) or hand a fact to the deterministic mover.
- **It stays quiet when there's nothing to do** — a calm, balanced setup should produce zero suggestions. "Silence" is the goal, not "look busy."
- **Hard brakes**: it can't propose the same thing repeatedly, can't fight the failover system, and if it keeps getting things reversed it gives up loudly and stops.
- **It backs off under load** — a system meant to make things smoother must not pile on when the machine is already struggling.

## What it means for you

A file you're about to need is often already there. Nothing moves your conversation on an AI's whim — that stays with plain, predictable rules. And if the "smart" preloading isn't actually smarter than simple rules, it quietly turns itself off. (The real cross-machine test waits until the Laptop is back online.)

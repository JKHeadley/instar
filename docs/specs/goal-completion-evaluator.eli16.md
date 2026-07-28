# Independent "are we done?" judge for autonomous mode — Plain-English Overview

> The one-line version: stop letting the worker decide it's finished, and bring in an independent judge to check a real finish-line — exactly how the new `/goal` feature works — and hand off to `/goal` itself where the framework already has it.

## The problem in one breath

When I'm working autonomously, the thing that decides "the job's done, I can stop" is *me saying so*. I can be wrong both ways — quit too early, or grind on after I'm actually done. The frameworks fixed this: their new `/goal` feature keeps an agent working until a *separate* model confirms a real, checkable finish-line.

## What already exists

- **Autonomous mode** — a safety latch keeps me working across turns until the job's done. Today "done" = I write a little "I promise it's done" token and the latch trusts it.
- **`/goal`** (just shipped in Claude Code and Codex) — you set a finish-line condition and an independent judge model checks after every turn whether it's truly met. Claude's `/goal` is, under the hood, the *same kind of latch* I already use.
- **Our own model-call plumbing** — instar already knows how to ask a small fast model a question (the same way our message-classifier and coherence checks do), with a daily spending cap.

## What this adds

- **An independent judge for "are we done?"** Instead of trusting my self-declared promise, the latch asks a fresh small model: "here's the finish-line and what just happened — is it met?" If no, keep going (with the judge's reason as a hint). If yes, stop. This works on *any* framework because it's our own judge.
- **Hand-off to native `/goal` where it exists.** On Claude and Codex, we let *their* `/goal` judge run the loop and we stand our own judge down (no point running two). We keep doing the things `/goal` can't: juggling multiple topics at once, budget caps, messaging you, and safety.

## The safeguards

**No more grading my own homework.** A separate model decides done, against a measurable finish-line.

**Never quits early by accident.** If our judge can't be reached (server down), we keep working rather than risk a false "done" — fail toward continuing.

**No double-judging.** Where the framework's `/goal` is active, our judge steps aside.

**The follow-up won't rot.** For v1 the judge reads the conversation (just like `/goal` does). Letting it run *real* checks itself (actually run the tests) is logged as a tracked commitment (ACT-152) that pings until it's done — not a comment that disappears. You specifically called this out, and it's handled.

## What ships when

Phase 1: our own independent judge (works everywhere) — the main win. Phase 2: hand off to native `/goal` where the framework has it. Each phase ships complete with its tests. Existing agents get it on their next update.

## The decision (settled)

You picked: run the judge every turn (tiny cost, capped), and v1 reads the conversation only — with the "run real checks too" enhancement tracked as a real commitment (ACT-152) that pings until it's done, not a someday-maybe.

# Per-job thinking effort, and a record of what each job was really given — the plain-English version

## What this is

Instar runs scheduled jobs: digests, checks, reviews and reports. Each job runs inside an AI engine, today usually Claude Code or Codex. Those engines let you choose how hard the model thinks before answering. Claude Code calls this "effort" and Codex calls it "reasoning effort". Thinking harder costs more of your subscription's usage and takes longer.

Today every scheduled job runs at the engine's default effort. A simple daily summary pays the same thinking cost as a careful code review. That is wasteful, and nobody can currently tell how much it costs, because Instar doesn't record what it actually told the engine.

## What already exists

Instar can already set the effort level for conversations: you can pin a Telegram topic to a "thinking mode". It also already knows how to translate one neutral thinking mode (off, low, medium, high, max) into each engine's own setting. The scheduler just never uses it for jobs.

## What's new

1. **A job can say how hard to think.** A new, optional `thinkingMode` setting on a job. If a job doesn't set it, nothing changes: the exact same command starts the engine as today.
2. **Each engine translates it in its own place.** Claude Code gets its effort flag and Codex gets its reasoning setting. On Claude Code, "off" switches thinking off through a setting rather than a flag. Codex has no "off", so it gets "low", and the record shows both what was asked for and what was sent. Engines with no such setting (Gemini, pi, Grok) simply don't get it, and the run says so. The rest of Instar never has to know which engine is which. That's a rule in Instar's constitution.
3. **Every job run records what it was really given.** It records which engine and model it actually ran on, the engine's version, what was asked for, what was actually sent, and what was dropped and why. The version is re-read if the engine updates itself, and a slow version check never delays a job. When a value can't be read, it says "unknown" instead of leaving a blank that looks fine. This record is the foundation for every later engine feature: backup models, tighter permissions, the advisor. Each of those can then show an honest before-and-after.
4. **A guard against the problem getting worse.** Instar has about 350 places where code checks "is this Claude or Codex?" outside the one place each engine's code is meant to live. A new automatic check fails the build if that number goes up. It doesn't force anyone to fix the old ones today; it just stops new ones creeping in.

## Safeguards

- Leaving the setting off changes nothing. Tests check that the start-up command is identical to today, character for character, on every engine.
- A bad value is rejected when the job is loaded, never in the middle of a run.
- An explicit effort pin that someone already set always wins.
- The record only claims a setting was **sent**, not that it made the engine better. Whether it helps is measured separately.

## How we'll know it works

This piece is only the mechanism: the setting and its record. First a throwaway test agent shows the record is right on each engine. Then one of my own jobs, the bug overseer, runs at low effort for a week. Every run's record has to match what was really sent, with no errors. Instar's regular feature review checks that.

Whether low effort actually saves usage without hurting quality is a separate, smaller design that comes next. It was split out of this one after the final review showed that measuring benefit fairly needs its own care: matching runs, engine versions, and how job quality is graded. Undoing this piece means removing one line from a job.

## What you need to decide

Nothing new. This follows the research step's recommendation. The two open questions I sent you (a simple list instead of sentinels, and the advisor coming later) don't block this piece.
<!-- approved 2026-11-11 by Justin (topic 141868) -->

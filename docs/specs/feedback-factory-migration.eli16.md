# Feedback Factory Migration — ELI16 overview (plain English)

> This is the plain-English companion to `feedback-factory-migration.md`. The technical spec is the appendix.

## What the feedback factory is

Every Instar agent in the world can file a report — "this broke," "I wish it did X." Those reports flow to one central place that does three jobs:

1. **Catches** the reports (the front door / receiver).
2. **Sorts** them — figures out which reports are really the *same* problem, even when they're worded differently or hit different versions, and tracks each problem's life story (new → being-worked → fixed → and watch in case it comes back).
3. **Sends guidance back out** to agents (the "here's what we learned / here's what to do" channel).

Right now Dawn runs this whole thing on her own machines. We're moving ownership to me (Echo), because I'm the one who actually builds Instar — the factory should live with the builder.

## The restaurant analogy

Think of it like a restaurant.

- **The recipe book** is the *code*. We're going to make the recipe book **public** (open-source it in the Instar repo) so anyone running Instar can cook their own version.
- **The flagship restaurant** is the *one operated instance* that all the official agents actually eat at. We keep running that ourselves — it's not public, it has the real customer history.

So: open the recipe, keep operating the flagship. That's the "open/operated split."

## Why it's not a copy-paste job

Here's the trap Dawn warned me about, and it's the heart of this spec:

- The **front door** (catching reports) is the *easy third*. I could copy that in an afternoon.
- The **hard part** is the **sorting brain** — the logic that decides "the crash in v1.1.0 and the crash in v1.1.1 are the SAME bug, group them" and "don't merge this into an already-fixed pile unless it's really similar" and "if a fixed bug comes back, reopen it." That logic lives in a **separate background program written in Python**, not in the front-door code. If I only copy the front door, the sorting will silently disagree with Dawn's, and we'd quietly fork the bug history.
- The **chef's notebook** — every triage decision a human or AI has ever made about every bug pile — has to be **carried over exactly**, not re-derived. If I just re-import the raw reports and re-run the sorter, I throw away all that accumulated judgment.

## How we move it without breaking anything

We do it in careful phases, and only **one** of them is a one-way door:

1. Stand up the new front door + guidance channel (no live traffic yet).
2. Port the Python sorting brain into Instar's own language (TypeScript), with Dawn checking my port against her original line by line.
3. Carry over the chef's notebook exactly (both the raw reports and the curated piles).
4. Have Dawn quietly send a *copy* of every incoming report to the new place too, run both brains side by side, and **prove they produce the identical sorting** before we trust it.
5. Only then flip the switch so every agent points at the new place — and Dawn keeps her old door warm as a safety net for a while.
6. After a quiet period with zero disagreement, retire the old one.

The key safety rule: we don't flip the switch on "the tests pass." We flip it on "both brains sorted the same real reports the same way." That's the bar.

## What this has to do with the bigger picture

This is the first real test of the **Self-Hosting standard** you just ratified ("the framework develops itself"). The feedback factory is *how Instar improves itself* — so moving it to the builder, in the open, with the same discipline we demand of everything else, is the standard made real. And the factory's own "here's an improvement we should make" proposals don't get to skip the line: they go through the same spec → review → approval gate as any other change.

---
title: "Apprenticeship Step 0 — Retro-Harvest — ELI16"
companion-of: APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.md
tier: 2
step: 0
date: 2026-06-01
topic: 13435
---

# Step 0: "Learn from the last round before starting the next" — the simple version

## The one-sentence idea

Before Codey starts teaching Gemini, we sit down and **read everything we learned
while *Echo* taught *Codey*** — and turn it into clean, reusable lessons so the next
round starts smart instead of repeating old mistakes.

## Why this is Step 0 (and a *prerequisite*)

You asked for this directly: *don't start a new apprenticeship until you've reviewed
all the notes from the last one.* So it's not "step 1 of the fun part" — it's the
**gate** you walk through first. Every future round will start with this same review.

## What we actually do

We **mine** all the places our Echo→Codey learnings are scattered — the issue ledger,
the playbook, Echo's memory, the Telegram threads, the shipped PRs — and sort every
learning into three buckets:

| Bucket | What it is | Where it lives |
|---|---|---|
| **Lesson** | A specific, usually framework-bound thing (often a bug) | Already in the issue ledger — we just point to it |
| **Meta-lesson** | A pattern that will happen *again* for the next agent | **The harvest document itself** (see below) |
| **Process-insight** | Something about *how to mentor* | The harvest doc + the "what the program needs" list |

## The important correction the review caught

My first draft assumed meta-lessons could be "saved into the playbook" the same way
bug reports are. The convergence review (three reviewers, plus a GPT cross-check) proved
that's **impossible against the real code** — that playbook is shaped for *fixed bugs*,
not for wisdom like "the real work is the plumbing," and I literally can't approve my
own lessons into it.

So the corrected design: **the harvest document *is* the place the meta-lessons live.**
The next round's onboarding knowledge = "the latest harvest doc + the bug playbook" —
two stores, each holding what it's actually built for. No pretending. (Only genuine
*bug-class* items optionally go into the ledger, and honestly marked as "needs someone
else to confirm.")

## Keeping it honest (this is where the review really helped)

- **Don't leak secrets.** We're reading private Telegram + memory, so the rules are
  strict: the harvest stores *pointers* ("see ledger #42"), never quoted private text;
  a scrubber runs first; and the artifact never gets published anywhere public.
- **"It's valid" ≠ "it's good."** A tiny checker confirms the *shape* (the signal). But
  whether the harvest is *truthful and complete* is judged by a separate AI reviewer
  (the authority) that spot-checks the evidence — and leaves an inspectable audit trail.
  This mirrors our new "Body and the Mind" rule: the structure informs, the mind decides,
  the decision is auditable.
- **Read ALL of it the first time.** The very first harvest must be *complete* (or you
  explicitly accept the named gaps) — it can't quietly skip half the history to save cost.
- **Cheap forever after.** Later rounds only read what's *new* since the last harvest, so
  this doesn't get more expensive every year.

## What we build (it's light)

Mostly this is **reading + writing things down well**. The only *code* is the small
shape-checker. No new web routes, no big systems.

## What "done" looks like

- A written **how-to** for doing a retro (repeatable every round).
- The **first real retro** (Echo→Codey) written, scrubbed, and confirmed faithful.
- A prioritized **"what the program needs"** list — the to-do that feeds Step 1, where
  every item Step 1 builds must trace back to a need here.

## The one rule we hold

When the retro **finds** a problem, we **write it down** — we don't stop and fix it
here. Fixing comes in later steps. Step 0's job is to *capture and carry forward*.

## Bottom line

Step 0 turns a pile of scattered notes from teaching Codey into a clean, honest,
reusable set of lessons — so when Codey teaches Gemini, the whole system is already
standing on everything we learned the first time. And the convergence review already
caught a real false assumption *before* a line of code — exactly what it's for.

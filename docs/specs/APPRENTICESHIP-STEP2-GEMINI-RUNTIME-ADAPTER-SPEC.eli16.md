---
title: "Apprenticeship Step 2 — Gemini CLI Runtime Adapter — ELI16"
companion-of: APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC.md
tier: 2
step: 2
parent-principle: "The Body and the Mind"
date: 2026-06-01
topic: 13435
---

# Step 2: "Teaching Gemini to be an Instar agent = building the plumbing" — the simple version

## The one-sentence idea

To let a *new* AI tool (Google's **Gemini CLI**) become a full Instar agent, we don't rebuild all
the smart agent features — those already exist and work no matter which AI is underneath. We just
build the **adapter**: the plumbing that lets Instar *talk to* Gemini the same way it already talks
to Claude and Codex. That plumbing is the real work.

## The "Body and the Mind" picture

Think of an Instar agent as having two parts:

- **The mind** — all the clever stuff: the Attention Queue, the Coherence Gate that double-checks
  before risky actions, the Playbook of remembered lessons, the dashboard, the follow-through
  tracking. This is *already built* and it's **AI-brand-agnostic** — it doesn't care whether the
  brain underneath is Claude, Codex, or Gemini.
- **The body** — the part that actually *runs* a specific AI tool: how to start it, how to send it
  a prompt, how to read what it says back, how to stop it, how to notice it's running low on memory.
  Every AI tool has a *different* body, because every tool is started and read differently.

So onboarding a new AI tool is **not** "build a whole new brain." It's "build a new body so the
existing brain can ride it." That body is called the **runtime adapter**, and building it is Step 2.

## Why this is the keystone (and why we *know* it's the real work)

We already proved this once. When we onboarded **Codex** (the previous round), the big lesson was a
surprise: the hard, real work was *all* in the body — starting the process, reading its output
format, handling its hooks, noticing when it's about to run out of context. The *brain features*
took **zero** new code; they just worked the moment the body underneath spoke Codex's language.

Gemini is the same bet, a second time. If we build a good Gemini body, all the agent smarts come
along for free. That's why this step is the **keystone** of the whole apprenticeship.

## The trap the first draft fell into (and why the new version is better)

When we wrote the first draft of this plan, we made a mistake: we listed the things to change by
looking at the **Codex body folder** instead of looking at the **whole codebase**. That hid two
problems the reviewers (reading the real code) caught:

1. **Silent landmines.** Several spots in Instar quietly assume the AI is Claude or Codex — how to
   find a session's saved transcript (for "resume where we left off"), how to tell a rate-limit has
   cleared, how to spot the running program in the process list. If a *new* AI hits those spots,
   nothing crashes — it just quietly does the wrong thing. These are the **exact** potholes we hit
   onboarding Codex. The whole point of the apprenticeship is to fix them *on purpose, up front*, not
   step in them again. The new plan lists each one (with the real file and line) and adds a **test
   that fails the build** if a future AI is added without fixing them — so the trap can't come back.
2. **"The compiler will catch it" was wishful thinking.** The first draft claimed that adding the new
   AI's name forces TypeScript to make us fix everything else. That's only true for a *few* spots.
   About ten others are silent — the compiler shrugs. The new plan writes them out as a checklist a
   human has to tick off, instead of pretending the machine guarantees it. (Ironically: claiming a
   safety net you didn't test is the same "a wall you assert is just a guess" lesson we teach
   ourselves — so we applied it to our own plan.)

We also corrected *where the real plumbing lives*: there's a fancy "registry" that looks like the
place to plug Gemini in, but in production it's actually switched off. The live wire is a small class
(`GeminiCliIntelligenceProvider`) that the "ask the AI a question" code actually calls — Codex has
the same thing. So the smoke test ("say PONG") has to run through *that*, or it isn't really proving
the body is alive.

And we tightened the safety screws: Gemini has a "just do whatever, no asking" mode (`--yolo`) — we
make sure the everyday path can never turn that on. We always strip out any Google billing keys so we
can't accidentally run up a bill. We cap how much output we'll swallow so a runaway can't crash us.
And Gemini's "hooks" can run commands, so we only ever listen, never let it run a command built from
the AI's own words.

## What we're actually building

A new folder, `src/providers/adapters/gemini-cli/`, that contains the plumbing:

| Piece | What it does | Plain words |
|---|---|---|
| **Registration** | Adds "gemini-cli" to the list of AIs Instar knows about | Teach Instar the *name* "Gemini" exists, in the 6 places it keeps that list |
| **Transport** | `gemini -p "<question>"` → read the answer | The "ask Gemini a question and catch the answer" pipe |
| **Config** | Find the `gemini` program, pick a model | Knows *where* Gemini lives and *which* Gemini to use |
| **Event reader** | Turn Gemini's output into Instar's standard format | A translator so the rest of Instar understands Gemini's chatter |
| **Hook receiver** | Listen to Gemini's built-in "hooks" | Gemini has a *nice* hook system (better than Codex's!) we can plug into |
| **Resume** | List / reopen / delete past sessions | Gemini gives us clean buttons for this — a freebie vs Codex |
| **Compaction signal** | Warn before Gemini runs out of memory | So work isn't silently lost when its context fills up |

The great news: a couple of these are *easier* with Gemini than they were with Codex. Gemini has
real commands for listing and resuming sessions (`--list-sessions`, `--resume`), and a richer
built-in hooks system. With Codex we had to dig through files by hand. So Gemini's body is, in a
couple of spots, actually a nicer fit.

## The honest part: this is a *start*, not a finish

Here's the thing we're being careful about — and the part we're *not* exaggerating:

The Codex body ended up with about **35** little capabilities. This Step 2 builds a **minimal**
Gemini body — enough that you can point Instar at Gemini and have it actually answer a prompt
end-to-end (we even have a "say PONG" smoke test that has to pass on the real machine). But it does
**not** build all 35 right away. The remaining ones get built *gradually*, as the apprentice
(Codey, who is mentoring Gemini) hits the real need for each one during real work.

We write that gap down on purpose, as a tracked "this is still ongoing" item — so nobody pretends
Gemini is "done" when really only its core is alive. Calling a half-built body "full parity" would
be a lie, and our test harness would actually *fail the build* if we claimed a feature we didn't
really implement. Honesty is baked into the structure, not left to good intentions.

## A few things we have to *find out* by running Gemini

We've already confirmed the basics work: Gemini v0.25.2 is installed, logged in, and answering
one-shot prompts cleanly. But a few details we can only learn by *running the program and watching*:

- What exactly Gemini's output looks like when we ask for machine-readable detail (so the translator
  knows the shapes).
- The precise rules of Gemini's hook system (what events, what reply format).
- Whether Gemini warns us *itself* before running out of memory, or whether we have to estimate it
  like we did for Codex.

The spec is honest about these: where we can't be 100% sure without live experimenting, we say so,
and we build the safe version (e.g. the translator never *throws away* a line it doesn't recognize —
it just labels it "raw" and passes it along).

## Why this matters for the bigger project

Once Gemini has a working body, the apprenticeship can move on: Codey can start *mentoring* Gemini
through real Instar work, and Echo can watch over the whole thing. But none of that can happen until
Gemini can actually *run*. This step is the foundation everything else stands on — the plumbing that
turns "a Google AI tool on the laptop" into "a real Instar agent." That's the whole game, and it's
why the body, not the brain, is where the work lives.

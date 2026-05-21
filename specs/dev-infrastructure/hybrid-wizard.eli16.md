# What this PR does — in plain English

## The story so far

The setup wizard is what walks a new user through installing their
AI agent — picking a name, an autonomy level, how to talk to it day
to day. The wizard was written as a long Claude skill file —
behavioral instructions like "speak conversationally", "wait for
the user to type their choice", "never show CLI commands". Claude
follows that kind of instruction reliably. Codex does not — Codex's
training pulls toward execution, so when Codex was given the same
skill, it just ran the whole setup non-interactively. The user
watched a stream of shell commands instead of having a conversation.

We tried two earlier patches in the last 24 hours. The first
(v1.2.10/11) fixed an unrelated model-selection bug so Codex could
even start. The second (now-closed PR #300) tried to force the
wizard to always run on Claude — but Justin pointed out that would
block Codex-only users without Claude installed.

The right shape, which Justin landed on, is: **specialized wizard
paths per framework, structure plus intelligence**.

## What we built

Two layers.

### Layer 1: the state machine

instar now owns the conversation flow. There's a list of "states" —
welcome, pick a name, pick a role for the agent, what should the
agent call you, how autonomous, messaging channel, etc. Each state
has a structural prompt text that instar prints verbatim, and a
deterministic transition based on the user's answer. The order is
fixed in TypeScript code. No LLM can drift it.

### Layer 2: the per-framework driver

- For Claude installs, nothing changes. Claude already follows the
  skill file reliably.
- For Codex installs, instar drives the state machine turn-by-turn.
  At each state, it asks Codex for ONE warm paragraph of intro text
  ("you're about to pick a name, here's why this matters"). Codex
  generates that paragraph, instar prints it, then prints the
  structural prompt itself, then reads the user's answer with
  `readline`. Codex never sees the question text and never decides
  what happens next.
- For agentic actions (specifically Telegram bot setup, where you
  need browser automation), instar spawns Codex as a full agent
  with Playwright. Here Codex's execution-orientation is an asset.

## Why this works

The wizard's contract is now enforced by code, not by prompt text.
Each turn of the Codex driver has a tightly bounded job: generate
one paragraph, no tools, read-only sandbox, ephemeral session. Codex
literally cannot decide to run `npx instar init` because there's
nothing to execute in a read-only sandbox during a 30-token text
generation. The structure is the guarantee.

But it still feels like a conversation, because Codex generates the
warm narrative text. Not a checklist. Not a chatbot script. A real
LLM-rendered intro for each step that picks up on the user's
previous answers ("got it, codey it is — let me ask about what it
should focus on").

## The "you can change this later" promise

Throughout the wizard and again at the end, the user is told they
can change anything later — name, autonomy, messaging, all of it —
by just chatting the agent. This is already how instar agents
work: they update their own config in response to natural-language
requests. The wizard just makes the affordance visible.

## What doesn't change

- The Claude wizard path. Untouched.
- The agent's runtime after setup. A Codex agent still runs on
  Codex. The wizard is just onboarding.
- Prerequisites. Both binaries are detected; the wizard uses
  whichever runtime the user picked at the runtime prompt.

## What's deferred to follow-ups

- Restore-flow, multi-user, and multi-machine entry points still
  run on the existing Claude SKILL.md path until ported. Today's
  most common failure (fresh project install on Codex) is what
  this PR fixes.
- WhatsApp and Slack: today the wizard prints a "configure later"
  pointer for those. A follow-up will give them their own agentic
  Codex sessions like Telegram has.

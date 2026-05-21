# Convergence Report — Hybrid wizard

## ELI10 Overview

The setup wizard walks new users through installing their agent.
It was written for Claude — long behavioral instructions like
"speak conversationally, wait for the user". Claude follows that
well. Codex's training pulls toward execution, so when Codex saw
the same wizard, it just ran the whole setup non-interactively.
The user got a generic agent and watched a stream of shell
commands instead of having a conversation.

This PR makes the wizard work on both runtimes by splitting the
problem: instar's TypeScript code owns the conversation flow (what
state comes next, what to ask, what side effects to run), and the
LLM is invoked per-turn only to generate warm narrative intro
text. Claude users keep the existing path. Codex users go through
the new state machine + per-turn narrative driver.

The Telegram setup phase still uses Codex as a full agent (because
driving Playwright + BotFather is execution, which Codex does
well), but for the conversational phases instar holds the line.

## Original vs Converged

The fix went through three shapes over the last day. v1.2.10 added
a `-m` model flag to the codex spawn (unblocked Codex from a 400
auth error). v1.2.11 was the model fix shipping. v1.2.12 (PR #300,
since closed) tried to force the wizard to always run on Claude,
which Justin rejected for blocking Codex-only users.

The converged design — this PR — provides structure AND
intelligence. Structure: a deterministic state machine owns
transitions. Intelligence: per-state narrative is rendered by the
framework's native LLM, picking up on the user's previous answers
to feel conversational rather than scripted. The two layers are
decoupled so each can be tuned independently.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | self + Justin's feedback (closed PR #300, requested specialized framework paths) | 2 | added state machine spec + Codex driver spec |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog

**Finding 1 — Forcing wizard to Claude blocks Codex-only users.**

- Severity: high (blocks the primary Codex audience entirely on
  hosts without Claude).
- Resolution: introduce per-framework drivers. Claude path uses
  the existing SKILL.md; Codex path uses the new state machine +
  per-turn narrative driver.

**Finding 2 — Telegram setup phase needs agentic capability.**

- Justin pointed out: "part of the wizard set up is initializing
  Telegram, which requires a framework that has access to
  Playwright to do not just Playwright a large language model
  driving it".
- Resolution: the state machine's `setup-telegram-agentic` action
  spawns the framework as a full agent (sandbox bypass, browser
  tools) for that one phase. Codex's execution-orientation is an
  asset here.

**Finding 3 — Settings-change-later promise.**

- Justin: "make it clear that settings can be changed later by
  chatting the agent".
- Resolution: terminal state farewell text explicitly tells the
  user that name, autonomy, personality, and messaging can be
  changed anytime by chatting the agent. The autonomy step's
  narrative prompt also surfaces this affordance.

## Convergence verdict

Converged at iteration 2. Two-layer architecture (state machine +
per-framework driver); per-turn narrative bounded by read-only
sandbox + ephemeral mode + tight prompts; existing Claude path
preserved unchanged; canary inverted to assert the new dispatch
contract. Spec is ready.

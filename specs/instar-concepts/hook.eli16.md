---
title: "Hook — ELI16"
slug: "hook-eli16"
parent: "hook.md"
---

# Hook — explained simply

## What it is

A **Hook** is a small script that runs automatically when something happens. "When a session starts → re-inject the agent's identity." "When the context window is about to be compressed → save important state." "When a Telegram message arrives → route it to the right place." Each "when X → run Y" pair is a hook.

Compared to skills (which the user invokes when they want help with something) and tools (which the model invokes during a turn), hooks are reactive — the agent or the framework triggers them based on what's happening in the system.

## Why it matters for Instar

Hooks are how Instar keeps the agent's identity and state coherent across framework restarts. Compaction recovery, session-start identity injection, the Telegram inbound relay — all hooks. If hooks don't work the same way on every supported framework, the agent loses its memory or its identity in ways the user notices immediately.

## What already exists

Both Claude Code and Codex CLI have native hook mechanisms. They use different file layouts, different event names, and different ways of registering scripts. Instar already uses Claude's hooks heavily; the Codex side has the file shape but the cross-framework parity has been hand-maintained.

## What's new in this spec

This spec formally writes down the Hook primitive in Instar terms and adds a parity rule (the second one in the registry, after Skill).

Three new things:

1. **A canonical event vocabulary** — Instar defines names like `session-start`, `pre-compact`, `compaction-recovery`, `telegram-message-received`. Some events Instar owns (Instar emits them, frameworks can subscribe). Some events the framework owns (Claude or Codex emit them, Instar provides a canonical name that maps to the framework's native event).
2. **Per-framework rendering specs** — how Claude expects hooks (script files + entries in `.claude/settings.json`) and how Codex expects them (entries in `.agent/openai/hooks.json` referencing script files).
3. **A parity rule for the `session-start` event** — proves the pattern. Subsequent events extend the mapping table mechanically.

## What this is NOT

This spec doesn't:

- Cover every event (only `session-start` for the proof; the rest are documented for next iteration).
- Handle the migration of existing agents' hooks into the canonical layout (same backfill story as Skill — one follow-up PR can cover both).
- Build a helper SDK for hooks that need to call an LLM (separate concern; tracked).

## What changes for the user

Nothing visible yet. Plumbing. Once the sentinel ships, hooks will stay in sync automatically across framework swaps.

## Why convergence was abbreviated

The first primitive (Skill) ran with six reviewers and surfaced thirty findings — most of which are template-level concerns (slug grammar, parser safety, stamp tracking, symmetric verify). All of those carry over to this spec. The architectural questions were settled at the foundational layer; this spec instantiates the pattern with hook-specific details (the event vocabulary).

Round one for this spec ran with two reviewers (security + integration) focused on what's actually new (event vocabulary + script executable contract + framework-side settings.json/hooks.json interaction).

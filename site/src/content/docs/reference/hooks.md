---
title: Hooks
description: Behavioral hooks that fire automatically via Claude Code's hook system.
---

Instar installs behavioral hooks that fire automatically through Claude Code's hook system. These are structural guardrails -- not suggestions.

## Hook Types

Claude Code supports four hook types that Instar uses:

- **PreToolUse (blocking)** -- Runs before a tool executes. Can block the action.
- **PreToolUse (advisory)** -- Runs before a tool executes. Provides guidance but doesn't block.
- **SessionStart** -- Runs when a new session starts or context is compacted.
- **UserPromptSubmit** -- Runs when the user submits a prompt. Used for per-message context injection.

## Installed Hooks

| Hook | Type | What it does |
|------|------|-------------|
| Dangerous command guard | PreToolUse (blocking) | Blocks destructive operations: `rm -rf`, force push, database drops |
| External operation gate | PreToolUse (blocking) | LLM-supervised safety for external service calls via MCP tools |
| Grounding before messaging | PreToolUse (advisory) | Forces identity re-read before external communication |
| Deferral detector | PreToolUse (advisory) | Catches the agent deferring work it could do itself |
| External communication guard | PreToolUse (advisory) | Identity grounding before posting to external platforms |
| Post-action reflection | PreToolUse (advisory) | Nudges learning capture after commits, deploys, and significant actions |
| Session start | SessionStart | Injects identity, topic context, capabilities, and pending serendipity findings at session start |
| Compaction recovery | SessionStart (compact) | Restores identity, conversation context, and serendipity finding count when context compresses |
| Telegram topic context | UserPromptSubmit | Injects per-message context (topic history, unanswered detection) for Telegram conversations |

## How They Work

Hooks are registered in `.claude/settings.json` and scripts live in `.instar/hooks/instar/`. They're installed automatically during setup and kept current by the PostUpdateMigrator on each version update.

### Blocking Hooks

When a blocking hook rejects an action, Claude Code receives a "blocked" response and must find an alternative approach. The agent sees the reason for the block.

### Advisory Hooks

Advisory hooks inject information into the agent's context before a tool executes. The agent sees the advisory and should incorporate it, but the tool isn't blocked.

### UserPromptSubmit Hooks

These run when a user (or Telegram relay) submits a message. They inject contextual information -- like topic history and unanswered message detection -- before the agent processes the prompt.

## Customization

All hook scripts are in your project directory and fully editable. You can:

- Modify existing hooks to change behavior
- Add new hooks for your specific needs
- Disable hooks by removing them from `.claude/settings.json`

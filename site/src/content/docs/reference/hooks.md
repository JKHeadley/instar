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

Hooks ship from two install paths. The static scripts under `src/templates/hooks/` get copied to `.instar/hooks/instar/` on install. A second set is generated dynamically by `PostUpdateMigrator` and written to the same location during the install pass. Both kinds are equally real; the split is purely about how they're maintained in the source repo.

### Static hook scripts

| Hook | Type | What it does |
|------|------|-------------|
| `dangerous-command-guard.sh` | PreToolUse (blocking) | Blocks destructive operations: `rm -rf`, force push, database drops |
| `grounding-before-messaging.sh` | PreToolUse (advisory) | Forces identity re-read before external communication |
| `free-text-guard.sh` | UserPromptSubmit (advisory) | Catches free-text inputs to multi-choice question flows that should be conversation messages instead |
| `session-start.sh` | SessionStart | Injects identity, topic context, capabilities, and pending serendipity findings at session start |
| `compaction-recovery.sh` | SessionStart (compact) | Restores identity, conversation context, and serendipity finding count when context compresses |
| `telegram-topic-context.sh` | UserPromptSubmit | Injects per-message context for Telegram conversations |
| `slack-channel-context.sh` | UserPromptSubmit | Same role as the Telegram hook but for Slack channels and DMs |
| `intercept-imsg-send.js` | PreToolUse (blocking) | Outbound safety layer for iMessage sends — validates recipient + send-token before `imsg send` |
| `skill-usage-telemetry.sh` | PostToolUse (advisory) | Records which skills the agent invoked during the session |
| `build-stop-hook.sh` | Stop (structural enforcement) | Used by `/build` and `/instar-dev` skills to prevent premature exit from phase-structured work |
| `model-tier-skill-entry.sh` | PostToolUse (signal) | Records that a tier-triggering skill (e.g. `/build`, `/autonomous`, `/instar-dev`, `/spec-converge`) started by writing the per-instance model-tier mode-state — only on a tier transition. Pure signal writer: never swaps a model, never carries a model id; the reconciler + server-side swap service decide what happens. Fail-closed (any missing input exits 0). |
| `model-tier-reconciler.js` | UserPromptSubmit (signal) | Computes the desired model tier from durable signals and, only on a transition, asks the server-side swap endpoint to act. Never swaps itself, never blocks the turn, emits no prompt context; the common path is a pure-filesystem early-exit no-op. Fail-closed to the session's default model. |

### Dynamically-generated hooks

These hooks live in `src/core/PostUpdateMigrator.ts` as template strings and get written to disk on every install/update. Same contract as the static hooks; different maintenance flow.

| Hook | Type | What it does |
|------|------|-------------|
| `external-operation-gate.js` | PreToolUse (blocking) | LLM-supervised safety for external service calls via MCP tools |
| `deferral-detector.js` | PreToolUse (advisory) | Catches the agent deferring work it could do itself |
| `post-action-reflection.js` | PreToolUse (advisory) | Nudges learning capture after commits, deploys, and significant actions |

## Observability event hooks

In addition to the behavioral hooks above, instar registers nine **event-reporter hooks** via `src/data/http-hook-templates.ts`. These forward Claude Code lifecycle events to `/hooks/events` for observability — they're not gates, they're listeners.

Events covered: `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `WorktreeCreate`, `WorktreeRemove`, `TaskCompleted`, `SessionEnd`, `PreCompact`.

The observability surface uses these to power session activity tracking, subagent failure detection, and the live dashboard. Inspect via `GET /hooks/events`.

## How They Work

Hooks are registered in `.claude/settings.json` and scripts live in `.instar/hooks/instar/`. They're installed automatically during setup and kept current by the `PostUpdateMigrator` on each version update.

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

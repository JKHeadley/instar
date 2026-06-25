# Subagent Permission Allow-Rules — Plain-English Overview

> The one-line version: add inherited permission allow-rules to every agent's settings so a helper sub-agent's shell command can't freeze an unattended autonomous run on an approval prompt nobody is there to answer.

## The problem in one breath

When an autonomous session delegates work to a helper sub-agent (the Task/Agent tool), the helper does NOT inherit the main session's "skip all permission prompts" mode. So the first time that helper runs a shell command, Claude Code pops the interactive "This command requires approval — 1. Yes / 2. No" dialog. In an unattended overnight run there is no human to press a key, so the session sits frozen on that modal dialog forever. To the operator it looks exactly like the "session paused" bug — and because every agent ships with the same settings, it hits the whole fleet (it was reproduced on this agent and on AI Guy).

## What already exists

- **`--dangerously-skip-permissions`** — the flag every instar Claude session launches with. It bypasses approval prompts, but ONLY for the main session. Confirmed against Claude Code docs: a Task/Agent sub-agent inherits the parent's permission *rules* but NOT its permission *mode*, so the flag doesn't reach the helper.
- **The `PermissionRequest` auto-approve hook** (`auto-approve-permissions.js`) — meant to auto-answer these prompts. It's defense-in-depth, but it does not reliably fire for sub-agent tool calls, which is why the prompt still surfaced in the screenshot.
- **The PreToolUse safety guards** — `dangerous-command-guard`, `external-operation-gate`, `external-communication-guard`, `self-stop-guard`, and others. These run on EVERY tool call and are the real safety. They are unaffected by this change.
- **`migrateSettings()` in `PostUpdateMigrator`** — the single migration entry point that patches every existing agent's `.claude/settings.json` on update and seeds new agents on init (the `cleanupPeriodDays` migration uses the exact same pattern).

## What this adds

A new `ensurePermissionAllowRules()` step inside `migrateSettings()` that adds a `permissions.allow` list covering the built-in tools a helper sub-agent uses — `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Task`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`. Sub-agents DO inherit permission *rules*, so an allow-rule is the structural lever that always applies — unlike the hook, which doesn't reliably fire for them. Because it rides `migrateSettings()`, every existing agent picks it up on its next update and every new agent gets it at init (Migration Parity).

## The new pieces

- **`ensurePermissionAllowRules(settings, result)`** — idempotent: it only adds tool names missing from the existing allow list, never duplicates an entry, and never touches the operator's `deny`/`ask` lists or any allow-rule they configured themselves. MCP tools (`mcp__*`) are deliberately NOT blanket-allowed — those are network/external operations that the external-operation-gate should keep governing with a plan/approval step.

## The safeguards

**Does not weaken safety.** Allow-rules only skip the duplicative human-in-the-loop *prompt*. The PreToolUse guards still run on every single tool call, so a dangerous command is still caught by `dangerous-command-guard`, an external op is still gated, and a self-stop is still flagged. "Allow" here means "don't ask a human who isn't there," not "don't check."

**Does not clobber operator config.** The migration is set-only-if-missing per tool name and leaves `deny`/`ask` completely untouched, so a hand-tuned permissions block survives unchanged.

**Stays scoped to local tools.** Network/external surfaces (MCP) keep their existing approval posture; only the local dev tools that were wedging unattended runs are pre-approved.

## What ships when

Single Tier-1 PR: the migration method + its wiring into `migrateSettings()` + the unit test that proves it adds the rules, is idempotent, preserves operator entries, and leaves deny/ask alone. It takes effect the moment an agent updates and restarts its sessions.

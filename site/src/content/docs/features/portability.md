---
title: Cross-Framework Portability
description: First-class support for Codex CLI alongside Claude Code.
---

Instar started life as Claude Code infrastructure, but the agent's identity, memory, scheduling, and messaging surface don't actually depend on Claude. Starting with v1.0.13, instar grew first-class support for [Codex CLI](https://github.com/openai/codex) as a second runtime. Codex agents get the same identity files, the same memory, the same scheduler, the same Telegram/WhatsApp/iMessage/Slack channels, and the same coherence gates.

A third runtime, **Gemini CLI**, was added through the apprenticeship program. Each runtime's one-shot judgment path is a dedicated intelligence provider — `CodexCliIntelligenceProvider` for Codex, `GeminiCliIntelligenceProvider` for Gemini — selected by the `buildIntelligenceProvider` factory from the agent's configured framework. See the [Gemini CLI Framework](/features/gemini-cli-framework/) page for the Gemini adapter specifics.

## Choosing a framework at setup

```bash
npx instar setup --framework codex-cli
```

The `--framework` flag steers the install wizard. With `codex-cli`, the wizard:

- Skips the Claude Code CLI prerequisite check
- Skips installing any `.claude/` files (a Codex-only install produces zero files in `.claude/`)
- Configures the Codex-specific transcript path and session conventions
- Registers the Threadline MCP server in Codex's `config.toml` instead of `.mcp.json`

Equivalent flag exists on `instar init` for adding instar to an existing project:

```bash
instar init --framework codex-cli
```

## What runs where

| Subsystem | Claude Code | Codex CLI |
|-----------|-------------|-----------|
| Agent identity (AGENT.md, USER.md, MEMORY.md, soul.md) | ✓ | ✓ |
| Telegram, WhatsApp, iMessage, Slack channels | ✓ | ✓ |
| Job scheduler with all fourteen default jobs | ✓ | ✓ |
| Coherence Gate, Policy Enforcement Layer, specialist reviewers | ✓ | ✓ |
| Lifeline, sentinels, watchdogs | ✓ | ✓ |
| Threadline relay + MCP tools | ✓ | ✓ (via Codex MCP config) |
| Self-Healing Remediator | ✓ | ✓ |
| Behavioral hook scripts | ✓ (Claude Code hook contract) | ✓ (Codex hook contract — different file layout) |

The two framework layouts coexist on the same machine. An agent that originally installed for Claude Code can add Codex support without rerunning init from scratch.

## Generic tier routing

Model names like "Sonnet" and "Opus" don't translate cleanly across providers. Instar uses a generic-tier vocabulary internally — `fast`, `balanced`, `deep` — that gets resolved to provider-specific model IDs at dispatch time. This means a job that says "use the balanced model" runs Sonnet on the Claude Code path and an equivalent OpenAI tier on the Codex path, without the job definition needing to know which.

## Framework-aware paths and stores

A handful of subsystems need to know which framework is active so they can read or write to the correct location:

- **FrameworkSessionStore** — transcript paths differ between Claude Code's `~/.claude/projects/<slug>/<session-id>.jsonl` and Codex's `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
- **Framework-aware telegram-reply.sh** — the script picks the right helper for whichever framework is running this session
- **FrameworkParitySentinel** — watches both framework configurations and surfaces drift if one ships an update the other hasn't received yet
- **Shadow capability mirror** — keeps a framework-neutral capability view so the agent's self-description is consistent regardless of which runtime serves a given turn

## The `enabledFrameworks` config field

Agents that want to run both frameworks side-by-side declare so in config:

```json
{
  "enabledFrameworks": ["claude-cli", "codex-cli"]
}
```

Dispatch decisions consult this list. If only one is enabled, the dispatcher skips framework-routing logic entirely and goes straight to the active runtime.

## When to choose which

| If you want… | Pick |
|------|------|
| Maximum capability for long-form reasoning | claude-cli (Sonnet 4.7 / Opus 4.7 tier) |
| OpenAI subscription as the primary cost surface | codex-cli |
| Both — different sessions for different cost / capability tradeoffs | both, with cost-aware routing |

The cross-framework support is also the foundation for future provider adapters (Gemini, local models, etc.) — the framework-neutral abstractions land first; provider-specific wiring snaps in.

## Migration

If you have an agent installed pre-v1.0.13, run any of:

- `instar upgrade-ack` (after the auto-update runs) — applies PostUpdateMigrator changes including the portability shim
- `instar migrate` — runs the migration explicitly

Either path is idempotent. Re-running causes no harm.

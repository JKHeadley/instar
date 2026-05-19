---
title: "Claude Code — Agent rendering"
slug: "frameworks-claude-code-agents"
framework: "claude-code"
primitive: "agent"
parent-concept: "specs/instar-concepts/agent.md"
---

# Claude Code — Agent rendering

## What Claude Code does

Claude's Task tool spawns subagents from markdown files discovered at `.claude/agents/<name>.md`. Each file has YAML frontmatter (name + description + optional tool restrictions) and a body that becomes the subagent's system prompt.

```
.claude/agents/<name>.md
```

Single-file format. No bundled scripts/references/assets at the framework level (the subagent can read project files like any session).

## Frontmatter shape

```yaml
---
name: <slug>
description: <when the parent should spawn this subagent>
tools: [Read, Grep, Bash]   # optional — restrict tool surface
model: sonnet | opus | haiku   # optional — model tier
---
```

## Canonical → Claude rendering

For each canonical agent at `.instar/agents/<name>/AGENT.md`:

1. Write `.claude/agents/<name>.md` with:
   - frontmatter copied verbatim (name, description) + transformations:
     - `model-tier: fast` → `model: haiku`
     - `model-tier: balanced` → `model: sonnet`
     - `model-tier: capable` → `model: opus`
   - `x-instar-stamp: <sha256>` for user-edit-conflict detection (same pattern as Skill/Hook).
   - body = canonical AGENT.md body.

## Known quirks

- Single-file subagents (no sibling assets); bundled scripts from canonical `.instar/agents/<name>/scripts/` are not rendered to Claude's side because Claude doesn't expect them. Subagents access project files directly.
- `tools:` field is Claude-specific and uses its native tool names; `allowed-tools` canonical field needs the Tool primitive's mapping (deferred).

## v0.1 status

Concept + this rendering doc ship in the Agent primitive PR. Actual `agentParityRule.ts` ships when Codex coverage is researched (so the registry gets a symmetric rule).

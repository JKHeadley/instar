---
title: "Claude Code — Tool rendering"
slug: "frameworks-claude-code-tools"
framework: "claude-code"
primitive: "tool"
parent-concept: "specs/instar-concepts/tool.md"
---

# Claude Code — Tool rendering

## Claude-native tool surface

Built-in tools shipped by Claude Code (subset Instar maps canonically):

- `Read`, `Edit`, `Write`, `MultiEdit`
- `Bash`, `Grep`, `Glob`
- `WebFetch`, `WebSearch`
- `Task`, `TodoWrite`, `NotebookEdit`
- `mcp__<server>__<tool>` for MCP-provided tools (double-underscore separator)

## Allowlist surface

Tool restriction is expressed via the `allowed-tools` (skill frontmatter) or `tools:` (subagent frontmatter) field:

```yaml
---
name: example
allowed-tools: ['Read', 'Bash', 'Grep']
---
```

For subagents (Task tool spawn):

```yaml
---
tools: [Read, Grep, Bash]
---
```

## Canonical → Claude rendering

From the TOOL_NAME_MAPPING:
- `read` → `Read`
- `edit` → `Edit`
- `bash` → `Bash`
- `mcp:github:list_issues` → `mcp__github__list_issues`

When a Layer-3 primitive's canonical declares `allowed-tools: ['read', 'bash', 'mcp:github:list_issues']`, the Claude-side rendering uses `['Read', 'Bash', 'mcp__github__list_issues']`.

## Known quirks

- Tool name case-sensitivity: Claude expects PascalCase for built-ins, double-underscore for MCP. Mixing fails silently (tool isn't recognized).
- `Task` tool (subagent spawn) — generally NOT in `allowed-tools` for sub-skills; restricting it would prevent the subagent from spawning further subagents (sometimes desired, sometimes not).

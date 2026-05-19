---
title: "Codex CLI — Tool rendering"
slug: "frameworks-codex-cli-tools"
framework: "codex-cli"
primitive: "tool"
parent-concept: "specs/instar-concepts/tool.md"
verified-against: "Codex CLI 0.130"
---

# Codex CLI — Tool rendering

## Codex-native tool surface

Codex 0.130 exposes built-in tools that overlap with Claude's surface but use different names:

- `view` (analogous to Read) — file inspection
- `apply_patch` (analogous to Edit/Write) — file modification
- `shell` (analogous to Bash) — shell execution
- `grep`, `glob` — same names
- `web_search`, `read_url` (analogous to WebFetch)
- MCP tools — addressed via the framework's MCP integration; naming convention may differ from Claude's `mcp__server__tool`

Note: Codex's exact tool naming has evolved across versions; this doc reflects 0.130 verified surface. Versions before 0.120 use different names.

## Allowlist surface

Tool restriction in Codex is expressed via `dependencies.tools` in the `agents/openai.yaml` sidecar of a skill (verified format, see `specs/frameworks/codex-cli/skills.md`). Sub-agent contexts may have a different surface.

## Canonical → Codex rendering

From the TOOL_NAME_MAPPING:
- `read` → `view` (Codex 0.130)
- `edit` → `apply_patch`
- `write` → `apply_patch` (with create semantics)
- `bash` → `shell`
- `mcp:github:list_issues` → `mcp.github.list_issues` (Codex MCP naming — to be verified)

## Known quirks

- Codex tool names use snake_case primarily; Claude uses PascalCase. Mapping table handles the case conversion.
- `apply_patch` is one tool covering both Edit and Write; canonical splits them but both map to the same Codex tool.
- MCP tool naming under Codex is less standardized than Claude's `mcp__server__tool` convention; the mapping uses dotted form pending live verification.

## v0.1 status

Tool name mapping ships as code in this PR. Live verification of every Codex-native name is pending — flagged for confirmation as soon as a Codex skill that uses `dependencies.tools` is observed in production.

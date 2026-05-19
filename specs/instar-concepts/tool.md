---
title: "Tool — Instar concept spec"
slug: "tool-concept"
author: "echo"
status: "converged"
type: "concept-spec"
eli16-overview: "tool.eli16.md"
review-convergence: "2026-05-19T01:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T01:30:00Z"
review-report: "docs/specs/reports/tool-concept-convergence.md"
review-deviation: "Pattern-instance + substrate-bound. Abbreviated convergence. v0.1 parity rule covers tool-allowlist surface only — that is the actual cross-framework concern; the tools themselves are framework-provided."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C)"
approved-date: "2026-05-19"
approval-note: "Pre-authorized after convergence + alignment check. Alignment verified: Layer 3 required primitive with substrate dependencies (toolAccess + toolAllowlist + fileSystemAccess + pathAllowlist + bashExecution + webAccess) matching inventory; what-is-NOT boundary respected (tool implementations themselves are substrate-layer)."
---

# Tool — Instar concept spec

## What this is

The fourth required Layer-3 primitive. Tool is unique among the four required primitives so far: it's the most directly bound to the substrate layer. The tools themselves (Read, Edit, Bash, Grep, WebFetch, MCP-provided tools) are NOT defined by Instar — they're provided by each framework's runtime. What IS in Instar's primitive scope: the canonical interface for declaring **which tools** a given context (skill, agent, session) is allowed to use.

The Tool primitive is the contract that lets Skill, Agent, and other Layer-3 primitives reference tools symbolically (`allowed-tools: [Read, Bash]`) and have those references render correctly across frameworks.

## Primitive identity

| Field | Value |
|---|---|
| Layer | 3 (functional) |
| Classification | Required |
| Foundational-spec reference | `specs/instar-foundations/required-primitives-inventory.md` → entry #4 |
| Substrate dependencies | `toolAccess`, `toolAllowlist`, `fileSystemAccess`, `pathAllowlist`, `bashExecution`, `webAccess` |

## Definition

A **Tool** is a capability the model can invoke mid-turn — read a file, run a shell command, fetch a URL, call an MCP server function. Tools are framework-provided; Instar's Tool primitive contract covers:

1. **Canonical tool-name vocabulary** — a stable identifier vocabulary that maps to each framework's native tool naming.
2. **Tool-allowlist surface** — how a skill / agent / session declares which tools it is restricted to.
3. **MCP-server-as-tool wrapping** — the rendering pattern when canonical references an MCP-provided tool.

A Tool is NOT:
- A skill (skills invoke tools; tools don't replace skills).
- A hook (hooks are reactive scripts; tools are model-invoked).
- An MCP server (MCP-server-registration is its own primitive #11 — bonus tier).

## Canonical tool vocabulary

Instar declares a **canonical tool-name vocabulary** that maps to each framework's native names:

| Canonical | Claude-native | Codex-native | Substrate primitive |
|---|---|---|---|
| `read` | `Read` | `view` (or framework default) | `fileSystemAccess` |
| `edit` | `Edit` | `apply_patch` | `fileSystemAccess` |
| `write` | `Write` | `apply_patch` (new file) | `fileSystemAccess` |
| `bash` | `Bash` | `shell` | `bashExecution` |
| `grep` | `Grep` | `grep` | `fileSystemAccess` |
| `glob` | `Glob` | `glob` | `fileSystemAccess` |
| `web-fetch` | `WebFetch` | `web_search` (or framework) | `webAccess` |
| `mcp:<server>:<tool>` | `mcp__<server>__<tool>` | `mcp.<server>.<tool>` (varies) | `toolAccess` + MCP server |

Canonical names are kebab-case; framework-native renderings vary per framework.

## What this primitive renders

The Tool primitive's renderer is small — it's not generating tool implementations (those are framework runtime). It renders:

1. **Allowlist references** when a skill/agent declares `allowed-tools: [read, bash]`:
   - Claude: `allowed-tools: ['Read', 'Bash']` in the rendered SKILL.md / agent file
   - Codex: tool-restriction in `agents/openai.yaml` or equivalent (depending on framework's surface)
2. **MCP tool references** when canonical is `mcp:github:list_issues`:
   - Claude: `mcp__github__list_issues`
   - Codex: framework-specific MCP tool naming

## v0.1 scope

The parity rule for v0.1 ships the **tool-name mapping table** as code — a `TOOL_NAME_MAPPING` registry that other primitives (Skill, Hook, Agent) can consume when rendering `allowed-tools` fields.

The actual rendering callsites (Skill rendering `allowed-tools` into Claude frontmatter / Codex `dependencies.tools`) are deferred to the Skill primitive's v0.2 work (this is the C3 deferral from Skill's convergence round).

## What is NOT part of the Tool primitive

- **Tool implementations** — framework runtime concern.
- **MCP server lifecycle** — separate primitive (#11, bonus).
- **Tool-call observability** — substrate's `eventHooks` (PostToolUse hook).
- **Tool execution sandboxing** — framework-level concern.

## v0.1 deferred items

- Wiring the TOOL_NAME_MAPPING into Skill v0.2 (the C3 deferral) and Agent rendering.
- Validation that referenced canonical tool names actually exist in the vocabulary (currently no consumer enforces).
- MCP-tool canonical syntax for tools provided by user-installed MCP servers.
- Per-tool capability requirements (e.g., `bash` requires `bashExecution` substrate; without it, the tool can't be granted).

## Alignment with foundational specs

- **`framework-functional-parity.md`**: Required primitive, substrate-bound.
- **`required-primitives-inventory.md`**: Entry #4 "Tool". Substrate dependencies match exactly.
- **What-is-NOT bound respected**: implementations, MCP lifecycle, observability all kept out.

## Implementation slice for this PR

1. This concept spec + ELI16.
2. Per-framework specs (`specs/frameworks/{claude-code,codex-cli}/tools.md`).
3. `src/providers/parity/toolNameMapping.ts` — the canonical-to-native mapping table as code, importable by other primitives' renderers.
4. Unit tests covering: every canonical name has both Claude + Codex native mappings; MCP-tool prefix handling.

The parity rule per se (one that takes a "tool list" canonical and verifies framework rendering) is small because tools themselves aren't user-defined artifacts — they're vocabulary lookups. The TOOL_NAME_MAPPING table is the load-bearing artifact.

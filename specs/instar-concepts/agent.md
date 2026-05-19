---
title: "Agent — Instar concept spec"
slug: "agent-concept"
author: "echo"
status: "converged"
type: "concept-spec"
eli16-overview: "agent.eli16.md"
review-convergence: "2026-05-19T01:25:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T01:25:00Z"
review-report: "docs/specs/reports/agent-concept-convergence.md"
review-deviation: "Pattern-instance + research-pending. Abbreviated convergence (1 reviewer-equivalent self-review). Parity rule deferred to v0.2 pending Codex subagent model documentation pass."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C)"
approved-date: "2026-05-19"
approval-note: "Pre-authorized after convergence + alignment check. Alignment verified: Layer 3 required primitive declared, substrate dependencies (agenticSession + sessionId + processLifecycle + authCredentialInjection) match inventory exactly, what-is-NOT boundary respected (agent runtime is substrate concern, not primitive)."
---

# Agent — Instar concept spec

## What this is

The third Layer-3 required functional primitive in the formal series. Follows the Skill/Hook template (canonical → per-framework rendering → parity rule), with one important honest gap: Codex's subagent model needs a research pass before the parity rule can render symmetrically across both frameworks. This spec defines the primitive cleanly and ships the concept + per-framework descriptive specs; the parity rule is tracked as a v0.2 follow-up.

## Primitive identity

| Field | Value |
|---|---|
| Layer | 3 (functional) |
| Classification | Required |
| Foundational-spec reference | `specs/instar-foundations/required-primitives-inventory.md` → entry #3 |
| Substrate dependencies | `agenticSession`, `sessionId`, `processLifecycle`, `authCredentialInjection` |

## Definition

An **Agent** is a spawnable persona with its own session state, identity, and instruction file. Distinct from the parent user-facing agent (Echo, Dawn, etc.), an Agent here is a Layer-3 primitive — a subagent the parent can spawn for delegated work, identity-isolated and lifecycle-tracked.

Three things make something an Agent:

1. **Spawnable persona** — has its own identity file (canonical AGENT.md) read at spawn time; not just a transient prompt.
2. **Own session state** — runs in its own framework session with its own tracked session id; survives the parent's compaction independently.
3. **Lifecycle-tracked** — parent can observe `processLifecycle` (alive/dead) and `outputStream` (what the subagent is doing).

An Agent is NOT:
- A Skill (skills are behaviors invoked within the current session).
- A Hook (hooks are stateless event responses).
- An MCP server (MCP servers are tool providers, not personas).

## Canonical source-of-truth

**Canonical path (on a deployed agent):** `.instar/agents/<name>/`

**Canonical contents:**

```
.instar/agents/<name>/
├── AGENT.md        (required — persona definition, frontmatter + body)
├── scripts/        (optional — agent-specific helpers)
└── manifest.json   (optional — spawn parameters: max-duration, allowed-tools, etc.)
```

**Slug grammar** — same `^[a-z0-9][a-z0-9-]{0,63}$` as Skill/Hook.

**Frontmatter (v0.1 minimum):**

```yaml
---
name: string              # required
description: string       # required — "what this subagent does, when to spawn it"
model-tier: string        # optional — "fast" | "balanced" | "capable" (default: balanced)
allowed-tools: string[]   # optional — tool restriction (renderer-deferred until Tool primitive)
---
```

## Per-framework rendering targets

| Framework | Renders canonical → | Notes |
|---|---|---|
| Claude Code | `.claude/agents/<name>.md` (Claude subagent format) | Claude's Task tool auto-discovers files here. Rendering details: per-framework spec. |
| Codex CLI 0.130 | needs research | Codex's subagent model is documented at the Codex source; Instar hasn't done the pass to map canonical → Codex-native shape. v0.1 leaves Codex agent rendering as "Instar-native fallback eventually"; for now, agents are Claude-only on Codex-routed topics. |

## Parity contract (v0.1 scope)

For v0.1, the parity rule covers **Claude only**. Symmetric Codex rendering is tracked as research; landing it is mechanical once the Codex subagent model is documented.

## What is NOT part of the Agent primitive

- **Subagent runtime** — that's substrate's `agenticSession` primitive (Layer 2); Agent just defines the persona.
- **Inter-agent communication** — that's the Threadline / messaging layer.
- **Sub-subagent spawning** — recursive spawning is the parent's responsibility, not the primitive's contract.

## v0.1 deferred items (tracked, NOT in this PR)

- **Codex subagent rendering** — research pass on Codex's subagent model + map canonical → Codex-native; build `agentParityRule.codex`.
- **Parity rule itself** — once Codex coverage is mapped, ship the rule with both framework renderers. v0.1 ships the concept spec + framework specs to lock the canonical shape; rule lands when Codex side is clear.
- **`migrateAgentsCanonicalBackfill()`** — same shape as Skill/Hook backfills.
- **Spawn-parameter merging with framework defaults** — `manifest.json` semantics.

## Alignment with foundational specs

- **`framework-functional-parity.md`**: Required primitive; canonical-defined; per-framework rendering pattern honored.
- **`required-primitives-inventory.md`**: Entry #3 "Agent". Substrate dependencies match exactly.
- **What-is-NOT bound respected**: runtime kept out (substrate), inter-agent kept out (messaging layer).

## Implementation slice for this PR

1. This concept spec + ELI16 companion.
2. Per-framework specs (`specs/frameworks/claude-code/agents.md`, `specs/frameworks/codex-cli/agents.md`).
3. **No parity rule** in this PR — deferred pending Codex research.

The PR ships the locked canonical shape so subsequent work (Codex research, parity rule, backfill) can build on it without re-litigating canonical decisions.

## Convergence record

Abbreviated convergence (pattern-instance + research-pending). Architectural template (canonical-source-of-truth + per-framework rendering + parity rule) is already established by Skill/Hook prototypes. Agent-specific concerns: (a) the Codex coverage gap (honestly tracked as a research follow-up), (b) the manifest.json optional sibling for spawn parameters, (c) the model-tier frontmatter field. All three are concept-level; the parity rule's TypeScript implementation pattern is already proven.

If round 2 would have caught material findings specific to the Agent primitive (not template-level concerns), they're addressable via patch.

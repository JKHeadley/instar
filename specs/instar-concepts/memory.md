---
title: "Memory — Instar concept spec"
slug: "memory-concept"
author: "echo"
status: "converged"
type: "concept-spec"
eli16-overview: "memory.eli16.md"
review-convergence: "2026-05-19T01:45:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T01:45:00Z"
review-report: "docs/specs/reports/memory-concept-convergence.md"
review-deviation: "Pattern-instance + substrate-bound. Abbreviated convergence. v0.1 parity rule covers canonical artifact presence + integrity; the loading-into-framework-context surface is the [[instruction-file-concept]] primitive's responsibility, not Memory's."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C)"
approved-date: "2026-05-19"
approval-note: "Pre-authorized after convergence + alignment check. Alignment verified: Layer 3 required primitive with substrate dependencies (memoryRead + memoryWrite + memorySearch + identityFiles + crossSessionPersistence) matching inventory; what-is-NOT bound respected (memory loading is the InstructionFile primitive's job; per-topic memory store is its own substrate concern)."
---

# Memory — Instar concept spec

## What this is

The fifth required Layer-3 primitive. Memory is the contract for **persistent agent state** — the artifacts that survive across sessions and machines, and that frame every new conversation. Unlike Skill / Hook / Agent (which describe what the model *does*), Memory describes what the model *is* and what it *knows about itself, the user, and prior work*.

The Memory primitive is the substrate-bound canonical-source-of-truth for `.instar/AGENT.md`, `.instar/USER.md`, `.instar/MEMORY.md`, and the per-topic memory store — and the contract by which any framework loads them into context.

## Primitive identity

| Field | Value |
|---|---|
| Layer | 3 (functional) |
| Classification | Required |
| Foundational-spec reference | `specs/instar-foundations/required-primitives-inventory.md` → entry #5 |
| Substrate dependencies | `memoryRead`, `memoryWrite`, `memorySearch`, `identityFiles`, `crossSessionPersistence` |

## Definition

A **Memory artifact** is one of the following canonical files (Instar-managed, machine-portable, git-synced):

| Canonical artifact | Purpose | Owner |
|---|---|---|
| `.instar/AGENT.md` | Agent identity — name, principles, role, boundaries | Instar scaffold + user edits |
| `.instar/USER.md` | User profile — preferences, context, relationships | Instar scaffold + user edits |
| `.instar/MEMORY.md` | Persistent learnings — written by the agent across sessions | Agent writes |
| `.instar/state/topic-memory.sqlite` | Per-topic structured memory — searchable, conversation-bound | Agent writes via API |

Together, these form the Memory primitive's canonical surface.

A Memory artifact is NOT:
- A skill, hook, agent, tool, or instruction-file (those are their own primitives).
- The mechanism by which canonical memory is loaded into framework context (that's the InstructionFile primitive — `CLAUDE.md`, `AGENTS.md`, etc., are the loading-vehicles, not the memory itself).
- A messaging history (relationships / messages live in their own substrate primitives).

## What this primitive renders

The Memory primitive's renderer in v0.1 is intentionally narrow: it does NOT generate framework-native memory files. Instead, it:

1. **Verifies canonical artifact presence**: every required Memory artifact exists at the expected path with non-zero content.
2. **Verifies artifact integrity**: YAML frontmatter (where present) parses; markdown body is non-empty; sqlite file (where present) is a valid SQLite file.
3. **Surfaces a manifest** consumable by the InstructionFile primitive — which is the primitive that actually renders `CLAUDE.md` / `AGENTS.md` and references the canonical Memory artifacts by path.

This narrow surface reflects the architectural reality: Memory itself is substrate-bound (files on disk, sqlite). The cross-framework concern is which framework-native loader picks them up — and that's the InstructionFile primitive's job, not Memory's.

## v0.1 scope

The parity rule for v0.1 ships a **canonical Memory verifier**:

- `verify()` — confirms each required artifact exists, has non-empty content, and (for `.md`) parses as YAML+markdown without errors.
- `listOrphans()` — returns empty in v0.1 (no rendering callsites yet; this stub exists for interface conformance).
- `removeOrphans()` — no-op in v0.1.
- `remediate()` — refuses; canonical Memory artifacts are user/agent-authored, not Instar-generated. Returns a structured error pointing to the missing artifact and the documented procedure for repair (re-init via `instar init` for AGENT.md / USER.md; for MEMORY.md, the user/agent restores from git or backup).

The deliberate non-remediation is the safety stance: Memory contains the agent's identity and accumulated learnings. Instar will never auto-generate or auto-overwrite these — corruption is loudly surfaced, repair is human-authorized.

## What is NOT part of the Memory primitive

- **Framework-native context loading** — InstructionFile primitive (separate; covers `CLAUDE.md`, `AGENTS.md`, system-prompt injection).
- **Memory write paths** — substrate's `memoryWrite` primitive.
- **Memory search** — substrate's `memorySearch` (FTS5-backed).
- **Per-machine ephemeral memory** — that's `~/.claude/projects/<path>/memory/MEMORY.md` (Claude Code's own auto-memory), NOT Instar-managed.
- **Backup/restore lifecycle** — separate substrate concern.
- **Compaction recovery hook** — separate primitive (uses Memory artifacts but doesn't own them).

## Alignment with foundational specs

- **`framework-functional-parity.md`**: Required primitive, substrate-bound. The cross-framework concern surfaces in the *loading* primitive (InstructionFile), not in Memory itself.
- **`required-primitives-inventory.md`**: Entry #5 "Memory". Substrate dependencies match exactly.
- **What-is-NOT bound respected**: loading mechanisms, search engine, backup lifecycle, ephemeral memory all kept out.

## v0.1 deferred items

- **InstructionFile primitive** — separate Layer-3 primitive (#6) covers `CLAUDE.md` / `AGENTS.md` rendering with embedded `@.instar/AGENT.md` references.
- **Memory-artifact schema validation** — beyond "YAML parses, body non-empty", we don't yet validate that `AGENT.md` has the required identity sections. Deferred to a Memory v0.2.
- **Per-topic memory primitive surface** — the sqlite file is canonical, but the cross-framework API for reading/writing topic memory is not yet defined in primitive terms. Deferred.
- **Memory.md size cap** — large MEMORY.md files degrade compaction recovery; no enforcement in v0.1.
- **Cross-machine merge conflict resolution** — git-sync handles most cases, but MEMORY.md merge semantics for concurrent agent writes need a dedicated primitive.

## Implementation slice for this PR

1. This concept spec + ELI16.
2. Per-framework specs (`specs/frameworks/{claude-code,codex-cli}/memory.md`) — both narrow, both pointing to InstructionFile for the loading surface.
3. `src/providers/parity/rules/memoryParityRule.ts` — verifier only.
4. Unit tests covering: present + valid artifacts pass verify; missing artifact fails with structured reason; corrupt YAML fails with structured reason; remediate refuses with documented detail; orphan list is empty.
5. Registry entry alongside Skill + Hook rules.

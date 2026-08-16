# Side-Effects Review — Agent + Tool + Memory primitives (batched)

**Version / slug:** `feat-primitives-batch`
**Date:** 2026-05-19
**Author:** Echo (autonomous mode, hybrid C)

## Summary of the change

Lands the remaining three Layer-3 functional primitive specs from the framework-functional-parity rollout as one batched PR: **Agent**, **Tool**, **Memory**. Each ships a small surface (concept spec + framework specs + small code artifact where applicable) and they share the same conceptual frame, so batching avoids three near-identical PR review cycles.

**Files changed (specs):**
- specs/instar-concepts/agent.md (new, converged + approved per pre-auth)
- specs/instar-concepts/agent.eli16.md (new)
- specs/instar-concepts/tool.md (new, converged + approved per pre-auth)
- specs/instar-concepts/tool.eli16.md (new)
- specs/instar-concepts/memory.md (new, converged + approved per pre-auth)
- specs/instar-concepts/memory.eli16.md (new)
- specs/frameworks/claude-code/agents.md (new)
- specs/frameworks/claude-code/tools.md (new)
- specs/frameworks/claude-code/memory.md (new)
- specs/frameworks/codex-cli/agents.md (new)
- specs/frameworks/codex-cli/tools.md (new)
- specs/frameworks/codex-cli/memory.md (new)
- docs/specs/reports/agent-concept-convergence.md (new)
- docs/specs/reports/tool-concept-convergence.md (new)
- docs/specs/reports/memory-concept-convergence.md (new)

**Files changed (source):**
- src/providers/parity/toolNameMapping.ts (new — TOOL_NAME_MAPPING table + renderers)
- src/providers/parity/rules/memoryParityRule.ts (new — verifier-only)
- src/providers/parity/registry.ts (memoryParityRule registered)

**Files changed (tests):**
- tests/unit/providers/parity/toolNameMapping.test.ts (new — 21 tests)
- tests/unit/providers/parity/memoryParityRule.test.ts (new — 18 tests)
- tests/unit/providers/parity/registry.test.ts (updated for 3-rule registry)

**Files changed (release notes):**
- upgrades/NEXT.md (rewritten for v1.0.4)
- package.json (version bump 1.0.3 → 1.0.4)

## Decision-point inventory

- **Batching three primitives in one PR**: justified by shared frame + small surfaces; each gets its own concept spec + ELI16 + framework specs + convergence report, so review traceability per primitive is preserved.
- **Agent primitive ships without a parity rule**: deliberate — Codex subagent surface (whether/how subagent spawning is exposed) needs live research. Spec ships now to lock the cross-framework contract; rule lands when research completes. Tracked in spec's "v0.1 deferred items" section.
- **Tool primitive ships TOOL_NAME_MAPPING as code, not as a per-instance rule**: Tools are framework-provided, not user-authored. The "instance" of a Tool isn't something to render; the cross-framework concern is the vocabulary, which lives in a shared mapping table. No registry entry — other primitives' renderers import the helpers directly.
- **Memory primitive uses flag-only remediation policy**: Memory contains agent identity + learnings. Silent regeneration would erase intentional drift. remediate() throws with a documented repair procedure; corruption surfaces loudly via verify().
- **SQLite verification depth**: v0.1 checks magic bytes only (cheap, fail-loud). Full schema validation deferred — the topic-memory.sqlite schema is owned by its own substrate primitive.
- **Memory artifact set is fixed at four**: AGENT.md, USER.md, MEMORY.md (required); topic-memory.sqlite (optional). Other `.instar/` files (config.json, jobs.json, state/*) are NOT Memory — they belong to other primitives (Config, Job, State).
- **MCP canonical syntax `mcp:server:tool`**: matches the spec convention. Renders to `mcp__server__tool` (Claude) / `mcp.server.tool` (Codex).

## Over-block / under-block analysis

**Over-block risk (Tool):** if a canonical tool name isn't in TOOL_NAME_MAPPING, `renderCanonicalToolName` returns null. Callers are documented to treat this as a hard error (don't silently drop, that widens the permission surface). v0.1 has no callers yet; risk surfaces when Skill v0.2 wires `allowed-tools`.

**Under-block risk (Memory):** the verifier checks presence + parseability, not semantic correctness. A syntactically-valid but content-wrong AGENT.md (e.g. missing the identity section) passes verify in v0.1. Acceptable for v0.1 — schema validation deferred. Under-block is loud (logged at sentinel scan time) rather than silent.

**Over-block risk (Memory remediate):** remediate always throws. If a future caller expects auto-fix as the default, this throws instead. Behavior is documented in the spec + in the rule's docstring + in the convergence report. Sentinel-level policy is `flag-only`, so the sentinel will never call remediate on Memory.

## Level-of-abstraction fit

- Tool name mapping: pure data table + tiny renderer. No state, no I/O. Appropriate for the substrate-bound primitive.
- Memory verifier: pure file I/O + YAML parse + magic-byte check. No mutation. No state.
- Both rules sit alongside skillParityRule + hookParityRule at the right abstraction layer (per-primitive verifiers consumed by the future FrameworkParitySentinel).

## Signal-vs-authority compliance

- toolNameMapping returns null for unknown — that's a signal to the caller, never a silent permission grant. Caller is the authority.
- memoryParityRule.verify returns structured mismatches — signal. The sentinel (not yet built) is the authority that decides what to do with the signal.
- memoryParityRule.remediate refuses unconditionally — this is the rule asserting authority over its own scope (Memory is sacrosanct), consistent with the "Memory is human-authorized" principle in the spec.

## Interaction surface

- Registry: third rule added (`memory`). No interactions with skill or hook rules.
- toolNameMapping: importable from `src/providers/parity/toolNameMapping.js`. No consumers in v0.1 (intentional — Skill v0.2 wires it).
- No changes to existing rules, scaffold, hooks, settings.json, or migration paths.
- No new HTTP routes. No new server-side state.

## Rollback cost

- Pure-add change. Revert is `git revert` on the merge commit. No data migration, no on-disk state created on existing agents, no settings.json mutations, no schema changes.
- Worst-case bug in Memory verifier: false-positive on existing agents that have unusual but valid Memory artifacts. Mitigation: rule is consumed only by the sentinel (not yet built), so v1.0.4 has zero runtime impact on agents.
- Worst-case bug in toolNameMapping: a canonical name renders wrong. Mitigation: no callers in v0.1; bug is caught when Skill v0.2 wires in.

## Test coverage

- toolNameMapping: 21 tests covering every entry's cross-framework resolution, MCP prefix handling, unknown-name null return, list ordering, mapping table invariants.
- memoryParityRule: 18 tests covering required vs optional artifacts, presence checks, empty content, YAML parse errors, unterminated frontmatter, SQLite magic byte verification, remediate-refuses behavior, orphan-empty behavior, rule metadata.
- registry: updated to assert the 3-rule shape.

## Documentation

- 3 concept specs (Agent, Tool, Memory).
- 3 ELI16 companions.
- 6 framework specs (3 × 2 frameworks).
- 3 convergence reports.
- NEXT.md updated.

## Deferred (tracked, not silent)

- Agent parity rule (pending Codex subagent surface research) — documented in `specs/instar-concepts/agent.md` "v0.1 deferred items".
- Skill v0.2 wiring of TOOL_NAME_MAPPING into `allowed-tools` — documented in `specs/instar-concepts/tool.md` + NEXT.md.
- Memory schema validation beyond YAML-parse — documented in `specs/instar-concepts/memory.md` "v0.1 deferred items".
- InstructionFile primitive (the loading-vehicle for canonical Memory into framework system prompts) — separate primitive, next.
- Migration backfill (Memory verifier is no-op on existing agents because canonical Memory already lives in `.instar/` — no migration needed).

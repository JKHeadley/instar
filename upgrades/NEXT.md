# Upgrade Guide — v1.0.4

<!-- bump: patch -->

## What Changed

Lands the remaining three Layer-3 functional primitives from the framework-functional-parity rollout: **Agent**, **Tool**, and **Memory**. Batched into a single PR because each ships a relatively small surface (concept spec + framework specs + small code artifact) and they share the same conceptual frame (canonical-source-of-truth + per-framework rendering).

**Agent primitive (v0.1):** concept spec + ELI16 + per-framework specs. No parity rule yet — pending Codex subagent surface research. The current Claude implementation pattern (.claude/agents/<name>.md) is documented but not yet wired to a canonical source. Tracked as a v0.2 follow-up; ships now to lock the cross-framework contract.

**Tool primitive (v0.1):** concept spec + ELI16 + per-framework specs + TOOL_NAME_MAPPING table as code (src/providers/parity/toolNameMapping.ts). Provides the canonical tool-name vocabulary (read, bash, web-fetch, mcp:server:tool) and helpers (renderCanonicalToolName, renderCanonicalToolList) that other primitives' renderers will consume when wiring allowed-tools fields. The C3 deferral from Skill convergence (Claude allowed-tools frontmatter + Codex dependencies.tools rendering) unblocks here — but the wiring itself happens when Skill v0.2 lands.

**Memory primitive (v0.1):** concept spec + ELI16 + per-framework specs + memoryParityRule (verifier-only). Confirms canonical Memory artifacts (.instar/AGENT.md, .instar/USER.md, .instar/MEMORY.md, .instar/state/topic-memory.sqlite) are present, non-empty, and well-formed. Deliberately does NOT auto-remediate — Memory contains agent identity and accumulated learnings, so silent regeneration would erase intentional drift. Corruption is loudly surfaced, repair is human-authorized. Loading canonical Memory into framework system-prompts (CLAUDE.md / AGENTS.md references) is the InstructionFile primitive's responsibility (next, separate spec).

Registry now exposes three rules: skill, hook, memory. Agent + Tool deliberately have no registry entry yet (Agent: rule pending; Tool: substrate-bound, ships as code-importable mapping rather than as a per-instance rule).

## What to Tell Your User

- "Three more functional primitives now have their canonical contracts in place: Agent (the spec is locked; the parity rule comes after Codex subagent research), Tool (a canonical vocabulary of names like read, bash, web-fetch that maps to each framework's native naming), and Memory (a verifier that confirms your AGENT.md, USER.md, and MEMORY.md files in the instar folder are present and well-formed)."
- "Memory verification is deliberately non-destructive — if it detects corruption, you'll get a clear repair pointer instead of an auto-overwrite that could wipe your identity drift."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Canonical tool-name vocabulary | Import renderCanonicalToolName or renderCanonicalToolList from src/providers/parity/toolNameMapping.js to translate canonical names into framework-native form. |
| Memory parity rule (programmatic) | Available via the parity registry — getParityRule('memory'). Verifier-only in v0.1; no auto-fix. |
| Agent + Tool + Memory concept specs | Read specs/instar-concepts/{agent,tool,memory}.md (+ .eli16.md companions) for the cross-framework contracts. |

## Deferred (Tracked Follow-ups)

- Agent parity rule (pending Codex subagent surface research).
- Tool: wire TOOL_NAME_MAPPING into Skill v0.2's allowed-tools rendering (resolves the C3 deferral from Skill convergence).
- Memory: schema validation beyond YAML-parse + body-non-empty (e.g. AGENT.md required identity sections).
- InstructionFile primitive — the loading-vehicle for canonical Memory into framework system-prompts. Separate spec, next.

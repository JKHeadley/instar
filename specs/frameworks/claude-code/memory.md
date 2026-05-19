---
title: "Claude Code — Memory rendering"
slug: "frameworks-claude-code-memory"
framework: "claude-code"
primitive: "memory"
parent-concept: "specs/instar-concepts/memory.md"
---

# Claude Code — Memory rendering

## Claude's memory surfaces

Claude Code has two memory mechanisms:

1. **Project instruction file** — `CLAUDE.md` (at project root) is loaded into the system prompt at session start. This is the primary mechanism by which canonical Instar Memory (`.instar/AGENT.md`, `.instar/USER.md`, `.instar/MEMORY.md`) gets surfaced to the model.
2. **Auto-memory** — `~/.claude/projects/<project-path>/memory/MEMORY.md` is Claude Code's own per-machine memory directory. NOT Instar-managed; lives outside the Instar substrate.

For the Memory primitive, only (1) interacts with canonical Instar Memory — and (1) is the InstructionFile primitive's responsibility, not Memory's.

## Memory primitive's job on Claude

The Memory primitive's responsibility on Claude is identical to its responsibility on any framework:

- Verify the four canonical Memory artifacts in `.instar/` are present, non-empty, and parse cleanly.
- Surface a manifest the InstructionFile primitive can use to wire `CLAUDE.md` references.

There is no framework-native "Memory file" Claude expects beyond what InstructionFile produces. Memory itself is substrate.

## Known quirks

- Claude Code's auto-memory directory can drift from canonical Instar Memory. The user-facing CLAUDE.md template documents this (see "Two Memory Systems" section). Memory primitive does NOT attempt to reconcile.
- Compaction can erase in-context memory. Recovery uses the canonical Memory artifacts via the session-start / compaction-recovery hooks. Those hooks are NOT part of Memory; they're [[hook-concept]] primitive instances that consume Memory.

## v0.1 status

Verifier ships as part of `memoryParityRule.ts`. Loading of canonical Memory into the Claude system prompt remains the responsibility of `CLAUDE.md` (project instruction file) — to be formalized when the InstructionFile primitive lands.

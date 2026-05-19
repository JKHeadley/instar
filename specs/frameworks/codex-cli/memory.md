---
title: "Codex CLI — Memory rendering"
slug: "frameworks-codex-cli-memory"
framework: "codex-cli"
primitive: "memory"
parent-concept: "specs/instar-concepts/memory.md"
verified-against: "Codex CLI 0.130"
---

# Codex CLI — Memory rendering

## Codex's memory surfaces

Codex 0.130 supports project-scoped agent instructions via `AGENTS.md` at project root (Codex's analog to Claude's `CLAUDE.md`). This file is loaded into the system prompt when a Codex session is launched in that directory.

Codex does not, to current knowledge, have a per-project auto-memory directory analogous to Claude's `~/.claude/projects/<path>/memory/`. Per-session memory is bounded to the session.

## Memory primitive's job on Codex

Identical to Claude:

- Verify the four canonical Memory artifacts in `.instar/` are present, non-empty, parse cleanly.
- Surface a manifest the InstructionFile primitive can use to wire `AGENTS.md` references.

The Memory primitive does NOT generate or modify `AGENTS.md` directly. That's the InstructionFile primitive's surface.

## Cross-framework parity notes

- Canonical Memory artifacts (`.instar/AGENT.md`, etc.) are framework-agnostic — they sit in `.instar/`, not in framework-specific directories.
- The framework-specific instruction file (`CLAUDE.md` on Claude, `AGENTS.md` on Codex) is what differs across frameworks. That difference is the InstructionFile primitive's parity concern, NOT Memory's.
- Recovery hooks that re-inject Memory after compaction (Claude) or session restart (Codex) are [[hook-concept]] primitive instances. The Hook primitive's canonical event vocabulary (e.g. `session-start`) covers both.

## Known quirks

- Codex's exact mechanism for loading AGENTS.md varies across versions. Verified for 0.130; earlier versions may not load the file at all.
- Some Codex versions support a global memory file (`~/.codex/AGENTS.md`) — Instar does NOT manage this; canonical Memory stays in the agent's project `.instar/` directory.

## v0.1 status

Verifier ships as part of `memoryParityRule.ts`. The actual Codex-side loading of canonical Memory into the system prompt will be formalized when the InstructionFile primitive lands.

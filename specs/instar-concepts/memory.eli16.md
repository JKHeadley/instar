---
title: "Memory — ELI16"
slug: "memory-eli16"
parent: "memory.md"
---

# Memory — explained simply

## What it is

A **Memory** is the stuff the agent knows about itself, the user, and prior conversations — the files that persist across sessions and machines. There are four canonical memory artifacts:

- `.instar/AGENT.md` — who the agent is (name, principles, role)
- `.instar/USER.md` — who the user is (preferences, context)
- `.instar/MEMORY.md` — what the agent has learned
- `.instar/state/topic-memory.sqlite` — per-conversation structured memory

These four are the agent's *real* memory. Everything else (Claude Code's auto-memory, framework system-prompts) is either a copy or a loader.

## Why it matters

Without a primitive contract over Memory, every framework would manage agent identity its own way and your agent would either lose its sense of self when you switched frameworks or end up with two competing identities (one in Claude's `~/.claude/`, one in `.instar/`). The Memory primitive says: the canonical files live in `.instar/`, every framework loads from there.

## What's new in this spec

A primitive contract that says "these four artifacts are canonical Instar Memory." A parity rule that verifies they exist and are valid. A deliberate refusal to auto-fix them — if your AGENT.md is corrupted, Instar tells you loudly, it doesn't silently regenerate (because that would erase whatever identity drift you actually wanted).

## What this is NOT

This spec doesn't define how `CLAUDE.md` or `AGENTS.md` get rendered — that's the InstructionFile primitive (separate, comes next). It doesn't define memory search (substrate). It doesn't define backup/restore. It defines what counts as canonical Memory and how to know it's intact.

## What changes for the user

Nothing visible yet. The verifier runs as part of the FrameworkParitySentinel (Step 5 in the rollout). When it spots a missing or corrupted Memory artifact, you'll get a structured alert pointing at the exact file and the documented repair path — instead of the current behavior where missing memory silently degrades agent context.

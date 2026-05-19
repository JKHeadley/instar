---
title: "Parity renderings backfill — ELI16"
slug: "parity-renderings-backfill-eli16"
parent: "parity-renderings-backfill.md"
---

# Parity renderings backfill — explained simply

## What this fixes

Instar ships canonical sources for skills, hooks, and memory entries — single files at known locations that describe each primitive in a framework-agnostic way. To actually use them, those canonical sources have to be rendered into the framework-native shape (Claude Code expects `.claude/skills/<name>/SKILL.md`, Codex expects `.agent/openai/skills/<name>/SKILL.md`, etc.). The Layer-3 parity rules know how to do that rendering.

Three recent PRs landed the canonical sources plus the parity rules, but none of them shipped the migration entry that fires the rendering on update. The plan was that a background sentinel would handle it on a scan cadence, but the sentinel isn't yet wired into the server boot path. So deployed agents updating from earlier versions had canonical sources on disk that were never rendered. The promise of canonical-to-framework parity was theoretical.

This release adds the missing piece. On every `instar update`, PostUpdateMigrator now walks the registered parity rules and re-renders every canonical instance for every enabled framework. It's idempotent — runs once per update marker — and respects each rule's individual policy. Hook renderings always overwrite per Migration Parity §4. Skill and memory renderings respect refuse-on-conflict per §5 (user-edited renderings are captured as skips, not silently clobbered).

## Why this is the right shape

This is a registry-iteration pattern, not a per-primitive hardcoded list. Whenever a new parity rule is added to the registry (Agent and Tool primitives are still pending parity-rule implementations), the backfill picks it up automatically. No PostUpdateMigrator changes are needed for new primitives — the per-rule remediate() encapsulates the rendering knowledge.

The migrate() function gains a new async sibling, migrateAsync(), instead of changing the existing sync signature. This avoids breaking any sync callers and keeps the existing 18 sync migration steps unchanged. The three production callers in CLI, UpdateChecker, and server are already in async contexts, so they update cleanly.

## What changes for you

For Justin: next update propagates every canonical skill, hook, and memory entry to the right framework-native locations. If any local agent has edited a rendered skill or memory file directly, the migration captures it as a skip and surfaces it in the update output — you can resolve via spec-converge or by editing the canonical source instead.

For deployed agents on other machines: same. The migration runs once on next update, renders everything that was deferred from the recent primitive PRs, and records the marker so subsequent updates are no-ops.

## What this is NOT

Not a behavioral change for users. Not a new primitive. Not a change to the parity rule policies — each rule's existing alwaysOverwrite or refuse-on-conflict decision is preserved. Just makes the canonical-to-framework rendering promise actually happen for existing agents.

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**feat(safe-fs): atomic-write helpers — cherry-pick from GSD-Instar spike.**

Adds `SafeFsExecutor.atomicWriteFileSync` and `atomicWriteJsonSync` — crash-safe file writes for file-backed state. The pattern: write to a temp sibling in the same directory, fsync to durable storage, then rename over the target (atomic on POSIX). A crash mid-write leaves either the old file intact or the fully-written new file — never a half-written one.

The failure this prevents: a direct `fs.writeFileSync` truncates then writes; a crash mid-write corrupts the file. For append-only event logs and JSON state, that means silent data loss when the next reader hits a parse error and falls back to an empty skeleton.

From the GSD-Instar integration spike (gsd-executor Rule 2 finding: file-backed state lacked atomic-write semantics).

## Evidence

9 unit tests, all green: string write, parent-dir creation, full content replacement (no partial residue), temp-file cleanup on success, mode option, JSON pretty-print + round-trip + custom indent + atomic overwrite. TypeScript compiles clean.

Side-effects review: `upgrades/side-effects/atomic-write-helper.md`.

## What to Tell Your User

Nothing user-visible. Internal hardening primitive for state files. Callers can opt into it incrementally — existing `fs.writeFileSync` callsites keep working unchanged.

## Summary of New Capabilities

Two new static methods on `SafeFsExecutor`. Not a destructive op, so they don't go through the source-tree guard, but they share the audit trail. No migration needed (library function, not an agent-installed file).

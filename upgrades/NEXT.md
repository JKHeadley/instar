# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**feat(hooks): slopcheck-guard — package-legitimacy check on installs (GSD cherry-pick).**

New PreToolUse hook that catches install commands (npm/pnpm/yarn/pip/cargo) for packages not already known to the project, and nudges the agent to confirm the package is legitimate before installing. Defends against slopsquatted and hallucinated package names.

When the staged Bash command is a package install, the hook extracts the package names, checks each against the project's manifests and lockfiles (package.json, package-lock.json, requirements.txt, Cargo.toml, etc.), and for any unfamiliar package injects a confirmation checklist (spelling, registry existence, deliberate-vs-hallucinated, established-alternative).

Signal-only — never blocks. Borrowed from gsd-executor's Rule 3 exclusion (package installs are NOT auto-fixable precisely because a failed/typo'd install may be a slopsquat).

## Evidence

10 unit tests, all green: non-install commands pass silently, unfamiliar npm install fires the nudge, packages in package.json/lockfile are familiar, version specifiers stripped, all five package managers recognized, multi-package commands flag only unfamiliar ones, flags stripped, malformed input never blocks, signal-only (never emits block). TypeScript clean.

Migration parity verified: new agents get it via settings-template.json; existing agents get it via an explicit ensure-block in `migrateSettings()` (added the Bash-matcher slopcheck entry if absent). Hook script always-overwritten by `migrateHooks()`. Registered in builtin-manifest.json + known-builtin-hooks list.

Side-effects review: `upgrades/side-effects/slopcheck-guard.md`.

## What to Tell Your User

Nothing user-visible. The hook fires silently and only the agent sees the nudge, only when installing an unfamiliar package. Existing agents pick it up on next `instar upgrade`.

## Summary of New Capabilities

One new PreToolUse hook on the Bash matcher. Catches the supply-chain risk that a hallucinated or typosquatted package name slips into an install. Framework-agnostic (pure Node, no Claude/Codex specifics).

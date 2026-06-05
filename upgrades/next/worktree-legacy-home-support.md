---
bump: patch
---

## What Changed

resolveAgentHome (the worktree-create agent-home guard) gains one narrow acceptance path: a home outside ~/.instar/agents/ is accepted iff the agent registry's recorded entry path (realpath-resolved) equals it and the entry name passes the existing charset clamp. The agent name comes from the registry entry, never the directory. Every prior refusal is preserved verbatim; planted files inside the candidate remain non-evidence.

## What to Tell Your User

Agents set up before the worktree convention (their home under ~/Documents/Projects/ or similar) can now use the standard worktree-create command like every other agent, instead of hand-building checkouts — which was the main source of their build failures.

## Summary of New Capabilities

- Legacy-home agents (registry-path-verified) get first-class worktree creation at `<legacyHome>/.worktrees/` — inside their own granted territory.

## Evidence

Found live in apprenticeship cycle 10 (2026-06-05): Codey's first command on a new build assignment — `instar worktree create codey/unit-suite-hermetic --base JKHeadley/main` — was refused with "is not under the instar agents root" despite his home being registered with a live heartbeat at exactly that path. 6 new unit tests cover both sides (env-var route, walk-up route, symlinked registration, planted-files-refused, hostile-name-refused, dangling-path-refused); the original hostile-AGENT.md refusal test passes unchanged. 49/49 green in the file.

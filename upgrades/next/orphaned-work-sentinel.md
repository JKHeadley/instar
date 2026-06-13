# Upgrade Guide — OrphanedWorkSentinel

<!-- bump: minor -->

## What Changed

A new dark, dev-gated, signal-only monitoring component — **OrphanedWorkSentinel** — detects agent worktrees that hold uncommitted work whose owning session has died and settled, records each durably, and raises ONE deduped agent-health attention item. It needs nothing registered: it reads the stranded work straight off disk (worktree dirty + no live process/lock + quiet for a settle window), closing the gap the PromiseBeacon escalation ladder (#1093/#1097) cannot see — that ladder acts only on REGISTERED commitments, while this catches code stranded by a dead build/autonomous session with no obligation representing it.

It is the inverse of `AgentWorktreeReaper` (which reclaims clean+merged+idle worktrees and leaves anything dirty alone) and shares the same git signal sources so worktree discovery + process-cwd liveness have ONE implementation. An optional, off-by-default `preserveWork` writes a NON-destructive preservation patch (read-only `git diff` to a state-dir file; never mutates the worktree, index, or ref). Read surface: `GET /orphaned-work` (503 when dark, 200 when live). Ships dark on the fleet, live on the development agent via the `developmentAgent` dark-feature gate.

audience: agent-only
maturity: experimental

## What to Tell Your User

Nothing to announce — this is an experimental, agent-only safety net that runs quietly in the background. If anyone asks: I now notice when a background work session dies before saving its changes, so that work gets surfaced instead of vanishing silently.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Detect work stranded by a dead session | Automatic (dark on fleet, live on dev agent) |
| Inspect orphaned-work findings | `GET /orphaned-work` |
| Non-destructive preservation patch | Off by default; opt-in config |

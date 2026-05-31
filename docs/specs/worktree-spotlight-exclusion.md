---
title: Worktree Spotlight exclusion (OS resource hygiene)
slug: worktree-spotlight-exclusion
status: approved
review-convergence: 2026-05-31T01:10:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate during an explicit
  5-hour autonomous run (topic 16782, 2026-05-30) where Justin directed: "put a
  lot of focus into what we can do to mitigate [macOS resource load] from the
  instar side" and confirmed OS resource hygiene belongs in the Responsible
  Resource Usage standard. Flagged in the PR per cross-agent discipline.
---

# Worktree Spotlight exclusion (OS resource hygiene)

## Problem

Live evidence on the dev box showed the single biggest CPU consumer was NOT
instar code but macOS indexing — `mediaanalysisd` ~80% CPU / 1GB RSS plus
`mds_stores` (Spotlight) — driven by ~118–121 git worktrees on disk under
`~/.instar/agents/<agent>/.worktrees/`. Each worktree is a full source-tree
checkout of the instar repo; Spotlight insists on indexing and re-indexing every
one. instar indirectly feeds a large OS-level CPU drain that has nothing to do
with agents doing work.

## Goal

Stop macOS Spotlight/mediaanalysisd from indexing agent worktrees, automatically
and for both new and existing agents. Level 4 (OS resource hygiene) of the
Responsible Resource Usage standard.

## Non-goals

- Not reclaiming stale worktrees (that is the sibling CLI-worktree-reaper work).
- No change to worktree creation semantics or the convention.

## Design

A single `.metadata_never_index` marker at the `.worktrees/` **container root**
tells Spotlight to skip the entire subtree (the marker is honored recursively).
Placing it at the container — not inside each worktree — means zero git noise
inside any worktree and one marker covers all of them regardless of how a
worktree was created.

- New exported helper `ensureWorktreeSpotlightExclusion(worktreesDir): boolean` in
  `InstarWorktreeManager.ts` — idempotent, best-effort (never throws; a write
  failure just leaves Spotlight indexing as before), returns whether it created
  the marker.
- `ensureWorktreesDir()` (the single chokepoint every CLI create path runs
  through) calls it, so new worktrees are covered at creation.
- The convention wrapper's raw-`git worktree add` fallback drops the same marker.
- `PostUpdateMigrator.migrateWorktreeSpotlightExclusion` backfills the marker into
  existing agents' `.worktrees/` on update (the wrapper itself is already
  always-overwritten by `migrateWorktreeConvention`, so the fallback change
  propagates for free).

## Decision points (signal vs authority)

None. This adds no decision logic and no blocking authority — it drops an inert
OS-hint file. Pure additive observability/hygiene. Per `docs/signal-vs-authority.md`,
nothing here gates information flow or behavior.

## Testing

Unit: the helper (creates marker, idempotent, never throws on an unwritable path)
and the migration backfill (drops the marker into an existing `.worktrees/`,
idempotent). Existing InstarWorktreeManager + migrateWorktreeConvention tests stay
green (the `ensureWorktreesDir` hook keeps its prior mkdir/chmod behavior).

## Rollback

Trivial. The marker is an inert file; deleting it restores indexing. A PR revert
removes the create-path drop + migration. No state, no schema, no irreversible op.

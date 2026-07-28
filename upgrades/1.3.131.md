# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Agent worktrees are now excluded from macOS Spotlight indexing — a top
OS-level CPU drain on multi-worktree machines.**

Each `instar worktree create` leaves a full source tree on disk under the agent's
`.worktrees/` directory. macOS Spotlight (mds_stores) and mediaanalysisd treat
every one of those trees as new content to index and re-index — and on a machine
that has accumulated dozens of worktrees that becomes one of the single biggest
CPU consumers on the box (measured: mediaanalysisd pulling ~80% CPU under a
~120-worktree backlog), entirely separate from anything instar's own code is
doing.

instar now drops a single `.metadata_never_index` marker at the `.worktrees/`
container root, which tells Spotlight to skip that whole subtree. New worktrees
are covered automatically at creation time, and existing agents get the marker
backfilled on update via a new migration. The marker lives at the container (not
inside any worktree, so it adds no git noise), is honored recursively for every
worktree beneath it, is harmless on non-macOS, and is idempotent.

This is the first piece of the **OS resource hygiene** facet of the Responsible
Resource Usage standard.

## What to Tell Your User

Nothing to configure. On a Mac, the throwaway worktrees instar creates for
parallel development will no longer be re-indexed by Spotlight — which quietly
removes a large chunk of background CPU load that had nothing to do with your
agents actually working. If you have built up a lot of worktrees over time, you
should feel this as lower idle CPU after the update settles.

## Summary of New Capabilities

- `instar worktree create` (and the convention wrapper's fallback path) drop a
  `.metadata_never_index` marker at the `.worktrees/` container so Spotlight skips
  indexing every worktree under it.
- New exported helper `ensureWorktreeSpotlightExclusion(worktreesDir)` — idempotent,
  best-effort, never throws, returns whether it created the marker.
- New `PostUpdateMigrator.migrateWorktreeSpotlightExclusion` backfills the marker
  into existing agents' `.worktrees/` on update.

## Evidence

- `tests/unit/worktree-spotlight-exclusion.test.ts` — new: the helper (creates the
  marker, idempotent return, never throws on an unwritable path) and the migration
  backfill (drops the marker into an existing `.worktrees/`, idempotent on re-run).
- `tests/unit/InstarWorktreeManager.test.ts` + `migrateWorktreeConvention.test.ts`
  still green (the `ensureWorktreesDir` hook + always-overwrite wrapper unchanged
  in behavior).
- Operationally verified live: dropping the marker on echo's real 121-worktree
  `.worktrees/` directory; mediaanalysisd dropped from its earlier ~80% spike.
- Full `npm run lint` clean.

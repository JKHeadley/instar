# Side-Effects Review — Worktree Spotlight exclusion

**Version / slug:** `worktree-spotlight-exclusion`
**Date:** `2026-05-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Drop a `.metadata_never_index` marker at the `.worktrees/` container root so macOS
Spotlight/mediaanalysisd skip indexing every worktree beneath it. Covered at
creation (`ensureWorktreesDir` → `ensureWorktreeSpotlightExclusion`, plus the
convention wrapper's fallback path) and backfilled for existing agents via a new
`PostUpdateMigrator.migrateWorktreeSpotlightExclusion`.

## Decision-point inventory

None. The change adds no decision logic — it writes one inert OS-hint file.

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing is rejected. The marker
only affects Spotlight indexing of throwaway build trees; it does not change git,
the worktree, the build, or any agent behavior. Source files inside worktrees are
unaffected (the marker is at the container, not inside a worktree).

## 2. Under-block

**What does this still miss?** It does not reduce indexing of anything outside
`.worktrees/` (by design), and it does not reclaim the worktrees themselves (the
sibling reaper work). Spotlight may take time to honor a newly-dropped marker on an
already-indexed tree, so the relief on existing backlogs is gradual, not instant.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The marker-ensure lives in `ensureWorktreesDir`, the single
chokepoint all CLI create paths run through, and the backfill lives beside the
existing `migrateWorktreeConvention`. The exported helper keeps the rule in one
place, reused by the migrator.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. The helper is best-effort and total: a write failure
returns false and is swallowed (`@silent-fallback-ok`), never throwing and never
blocking worktree creation or a migration pass.

## 5. Interactions

Reuses `resolveAgentHomeForWorktree` (same validation as `migrateWorktreeConvention`)
so non-convention agents are skipped silently. The wrapper fallback change rides the
existing always-overwrite of `instar-worktree-create.sh`. No interaction with the
SessionReaper, sentinels, or recovery paths. Idempotent everywhere.

## 6. External surfaces

One new on-disk file per agent (`.worktrees/.metadata_never_index`, empty). No HTTP
routes, no config, no notifications, no Telegram. Purely a filesystem hint to the OS.

## 7. Rollback cost

Trivial. Delete the marker to restore indexing; revert the PR to remove the
create-path drop + migration. No state, no schema, no irreversible op.

## Conclusion

Lowest-risk possible change: additive, inert, idempotent, best-effort, reversible,
no decision logic. Directly targets a measured top OS-level CPU drain (mediaanalysisd
~80% under a ~120-worktree backlog). Operationally pre-validated by dropping the
marker on echo's real `.worktrees/` (121 worktrees) live.

## Second-pass review (if required)

Not required — inert additive OS hint, no authority, no decision logic.

## Evidence pointers

- `tests/unit/worktree-spotlight-exclusion.test.ts` — helper + migration backfill.
- `tests/unit/InstarWorktreeManager.test.ts`, `migrateWorktreeConvention.test.ts` — green.
- `upgrades/NEXT.md` — upgrade guide.

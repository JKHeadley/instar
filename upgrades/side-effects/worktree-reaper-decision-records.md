# Side-effects review: worktree reaper gate records and capacity refusal text

**Date:** 2026-11-05
**Author:** Echo
**Tier:** 1, declared below the path-based risk floor because the reaper ships off and a revert fully undoes this. Two source files, one test file each. Second-pass reviewer result is recorded at the end.

## Summary and decisions

The reaper treats untracked or ignored files matching the gate's exact timestamped record names as not being work, and copies them to `.instar/instar-dev-decisions-archive/<worktree>/` before non-forced removal. The capacity refusal gains a breakdown of what fills the folder. The 500 bound, what it counts, and the reaper's enabled default are unchanged.

Measured limit: of 303 worktrees the reaper kept on the Mac Studio on 2026-11-05, 261 have no status entries other than qualifying records, but all 303 also hold other ignored files (build output, audit logs), which the 2026-10-28 rule still treats as keep. So this change alone makes none of those 303 reapable. Relaxing that rule was left out on the coordinator's instruction and is reported as an open decision.

## 1. Over-block

Locally edited tracked records still keep a checkout, because the source-tree guard refuses `git restore` and that guard was not widened. A folder of ignored records that git reports as a folder, not as named files, also keeps it. Both fail toward keeping.

## 2. Under-block

A person could hand-write a file with the exact timestamped name. It would be archived, not lost, so the harm is limited to the checkout being removed. Between the archive read and `git worktree remove`, a new ignored file could appear; `reclaimRaceGuard` narrows that window and does not close it, as before this change.

## 3. Level of abstraction

The exception sits in `isClean` and `removeWorktree`, the reaper's own signal and deletion step. `REAPER_RESIDUE_DENYLIST` stays empty because it matches by broad prefix. The refusal text belongs where the refusal is raised.

## 4. Signal vs authority

Per `docs/signal-vs-authority.md`, the pattern match narrows what a deletion authority may remove, and any doubt keeps the checkout. The capacity bound is a hard resource limit; only its message changed.

## 5. Interactions

`OrphanedWorkSentinel` reuses `isClean`, so a records-only worktree would stop being reported as orphaned work; those records are not stranded work. `isClean` now passes `--untracked-files=all`, which lists more entries and costs slightly more on large untracked trees. Dry-run passes do not call `removeWorktree`, so they write nothing.

## 6. External surfaces

The refusal message text changes; its `worktree-capacity: N directories` prefix, which tests and the CLAUDE.md guidance rely on, does not. A new archive folder appears in an agent home only when an enabled, non-dry-run reaper removes a worktree holding records.

## 7. Multi-machine posture

Machine-local by design: worktrees and their archive live on the machine that built them. The archive writes its own `.gitignore` so state sync, which adds everything not ignored, does not replicate it. Nothing depends on another machine.

## 8. Rollback cost

Revert the PR. Archived files stay where they are and are harmless. No state or config migration, and no agent-installed file changes.

## Second-pass review

An independent reviewer raised one concern: the archive folder was not ignored, so state sync could replicate records, contradicting section 7. Fixed by the archive's own `.gitignore`. It also noted that a locked checkout would lose its records from the checkout before removal failed, and that no fsync preceded the delete. Both are fixed and the lock case is tested. It found no defect in path parsing, name handling, ordering, the 500 limit or the enabled default. Concur after these fixes.

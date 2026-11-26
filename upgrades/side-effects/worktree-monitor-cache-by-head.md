# Side-Effects Review — WorktreeMonitor caches per-worktree results by commit

## Summary of the change

`WorktreeMonitor.checkUnmergedWork` now caches its result (commits ahead, changed files, count) under `<defaultBranchSha>:<worktreeHead>`. `getWorktreeAge` caches commit times by commit sha. The scan resolves the default branch's commit once (`git rev-parse --verify --quiet`) and rebuilds the unmerged cache each scan, so entries for vanished worktrees, or for an older default-branch commit, drop out. The commit-time cache is pruned to live heads when it grows past four times the worktree count (at least 64 entries).

Why: each scan started 2 to 3 git processes per worktree (`rev-list --count`, `diff --name-only`, `show -s`), over 850 per 5-minute scan on the Studio (fb-9f890bce-bd2). A quiet scan now starts about 3 git processes in total. It is stacked on #3494 (which is on #3461).

## Decision-point inventory

None. These are read-only reports.

## 1. Over-block

None.

## 2. Under-block

A changed result for an unchanged pair of commits is impossible: commits ahead and the diff are functions of those two commits. An empty `show -s` read is not cached, so it is retried. If `rev-parse` fails, nothing is cached and the scan behaves exactly as before.

## 3. Level-of-abstraction fit

The cache lives inside the monitor, the only caller.

## 4. Signal vs authority compliance

These are reports only. No authority is involved.

## 4b. Judgment-point check

None.

## 5. Interactions

The report has the same shape. A cached hit returns the current `worktree` object with the cached numbers.

## 6. External surfaces

None.

## 6b. Operator-surface quality

None.

## 7. Multi-machine posture

`machine-local-justification: hardware-bound-resource`. The cache is in-memory and per machine.

## 8. Rollback cost

Revert the commit. There is no persisted state.

## Conclusion

Safe. It removes most of the scan's process churn.

## Second-pass review (if required)

Not required.

## Evidence pointers

`tests/unit/worktree-monitor.test.ts` gains 2 new cases:
- a second scan of an unchanged repository makes 0 per-worktree git calls and gives an identical result;
- a merge into the default branch forces a fresh `rev-list` and clears the unmerged entry.

The file passes 39 of 39. tsc is clean.

## Class-Closure Declaration (display-only mirror)

Class: unbounded-self-action. Closure: n/a. This is a read-only cache, with no self-triggered action added or changed.

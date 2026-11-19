# Side-Effects Review — Worktree monitor report keeps 50 file names per branch

**Version / slug:** `worktree-monitor-report-cap`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `not required`

## Summary of the change

`WorktreeMonitor.checkUnmergedWork` used to store the full `git diff --name-only main...branch` list on each unmerged worktree. It now stores the first `FILES_CHANGED_KEPT` (50) names plus `filesChangedCount`, the total. The text notice uses the count for its "+N more".

On the Studio, `last-report.json` was 314 MB, and 272 MB of that was these lists across 404 entries. It was rewritten synchronously every 5 minutes. Measured in a separate process on the Studio, the rewrite took 261 ms for stringify plus 425 ms for the write. Filed as fb-411b9b0c-6a6. Stacked on PR 3334 (single-flight scans), which changes the same file.

## Decision-point inventory

*(none)*. This changes what is stored; no decision reads the list.

## 1. Over-block

No issue identified. Nothing is blocked or filtered; every unmerged worktree is still reported.

## 2. Under-block

A caller that wanted the full file list from the stored report now gets 50 names. A search of `src/` and `dashboard/` found no such caller: the only consumer is the notice, which uses 5 names. `filesChanged.length` no longer equals the total, so a reader should use `filesChangedCount`. That field is new, and the notice falls back to the list length for older stored reports.

## 3. Level-of-abstraction fit

The fix is at the point the data is produced. The report stays bounded for the server's in-memory copy, the file, and any route that serves it.

## 4. Signal vs authority compliance

Not applicable: no authority. The monitor only reports.

## 5. Interactions

PR 3334 (one scan at a time) changes the same file, so this is stacked on it. `git diff` still runs and still produces the full output in the child process; only what is kept shrinks. The size of the git output is unchanged.

## 6. External surfaces

`last-report.json` and the in-memory `lastReport` have a truncated `filesChanged` plus the new `filesChangedCount`. The notice text is unchanged in shape and its count is now correct.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: hardware-bound-resource`. The report describes this machine's own git worktrees on its own disk. Each machine writes its own, as before.

## 8. Rollback cost

Revert the commit. There is no state migration: the next scan rewrites the report in whichever shape the running code uses.

## Conclusion

A small change that bounds the report. It removes a ~0.7 s event-loop stall every 5 minutes and about 90 GB a day of disk writes on the Studio.

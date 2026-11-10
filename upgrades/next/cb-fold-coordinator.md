<!-- bump: patch -->
## What Changed

Adds the FoldCoordinator for the Context Budget work (`src/monitoring/FoldCoordinator.ts`, `foldCarriers.ts`, `foldCoordinatorBoot.ts`): the single writer of a durable per-fold record (compare-and-swap transitions fenced by the per-topic fold lock), carriers keyed by fold id and released only by the record's terminal transition, a quarantine handover to the sentinel, a consecutive-rollback breaker, and a boot sweep (`recoverPendingFolds`) that runs on every server start before the inbound-queue and pending-inject sweeps. A crashed fold before the point of no return is discarded; one past it is quarantined; carriers with no record are released and reported. Pending-inject records tagged with a fold are skipped by the generic inject sweep. Fold records and fold-lock files are never backed up. No fold can begin yet (the sentinel and layer kind are later slices), so on a healthy agent the sweep finds nothing.

## What to Tell Your User

Nothing changes for you yet. This is the part that will make sure that if I'm ever interrupted halfway through reorganizing a conversation's working memory, I clean up or roll back safely on restart instead of leaving it half done.

## Summary of New Capabilities

- Crash-safe bookkeeping for the coming conversation-folding work, with a cleanup pass on every restart; not used for folds yet.

## Evidence

- Unit `tests/unit/FoldCoordinator.test.ts` (30) and `tests/unit/BackupManager-never-backup.test.ts`; integration `tests/integration/fold-coordinator-boot-wiring.test.ts` (9) with the real lock and carriers across a simulated restart; e2e `tests/e2e/fold-coordinator-crash-lifecycle.test.ts` (4) with a real child process killed mid-fold at three steps, then a server-style boot sweep.

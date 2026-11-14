# Side-Effects Review — legacy default job reconciliation

**Version / slug:** `legacy-default-job-reconciliation`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** independent review found a pre-migration overwrite risk; corrected with an add-only update path and regression tests. Awaiting final concurrence.

## Summary

Tier 1. Reconcile missing legacy default jobs on every update before legacy migration. Keep git-sync disabled by default and never auto-enable it from Git remote detection.

## Decision-point inventory

- A shipped default may be added only when its slug is absent. Existing jobs retain operator settings.
- Git-sync enablement is operator-controlled. A remote is not an enable signal.

## Over-block

An agent that expected newly installed git-sync to run automatically must explicitly enable it. That is deliberate because the job can stage token-bearing config. Existing enabled entries are preserved. A previously removed default has no tombstone in legacy jobs.json, so it will be re-added on update; the operator can disable it to preserve that choice durably.

## Under-block

This step does not replicate custom job definitions or external dependencies to a peer. It does not inspect a previously enabled git-sync entry for safe exclusions. The update pass only runs where `jobs.json` exists; agents already on per-slug manifests use the existing builtin installer.

## Level of abstraction and signal vs authority

The init refresh already owns legacy default merging, and PostUpdateMigrator owns update-time file changes. Reuse the same merge logic at both seams. Git remote detection is removed from the enable decision because it is a weak signal for a security-sensitive action.

## Interactions

The update call runs after built-in agentmd installation and before legacy jobs.json migration. New defaults can be migrated with the rest. The update merge is add-only and preserves every existing entry byte-for-byte after parsing. A malformed jobs.json is reported as a migration error and left unchanged. The setup refresh retains its existing gate/execute repair behavior.

## External surfaces and multi-machine posture

A second machine that updates receives missing shipped defaults in its own catalog; this does not require git-sync or a shared repository. A legacy git-sync entry added on update remains disabled. A promoted machine still needs the scheduler takeover fix to execute its catalog.

## Rollback cost

A revert restores prior setup and update behavior. Any defaults already added remain in jobs.json; the operator can disable or remove them. No irreversible migration is introduced by this change.

## Class-Closure Declaration

No self-action loop is added. Refresh is idempotent by slug and tests run it repeatedly. Git-sync activation requires an explicit operator edit.

## Second-pass review

Independent review caught a pre-migration overwrite of customized legacy jobs. The update path is now add-only, and tests prove customized bodies survive and malformed files are reported unchanged. The legacy format has no deletion tombstone, so missing defaults are re-added; this is documented above and an operator can disable a default durably. **Concur with the review** after these changes.

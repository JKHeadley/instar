# Subscription pool: the shared login-list file moves to a per-machine store

## What Changed

Builds the legacy single-file migration named in the approved spec `subscription-pool-authority-foundation.md` (operation `legacy-migrate`), prompted by instar#2122 (a joined machine inherited the first machine's login locations through the git-shared `.instar/subscription-pool.json`).

- `SubscriptionPoolAuthorityStore.migrateLegacy` + `recoverLegacyMigrate`: witness bound to the untouched source's SHA-256+size; staging, finalize, rebuild-from-matching-source, fail-closed recovery per the spec table.
- `SubscriptionPool.migrateLegacyToMachineLocal`: drops rows whose login home is not on this machine; `persist()` writes to the authority once one is published, even with a legacy file still present.
- `PostUpdateMigrator.migrateSubscriptionPoolToMachineLocal`: `.gitignore` entry, one-time publication, legacy file removed only when untracked (a tracked copy stays — deleting it would propagate to peers). `GITIGNORE_ENTRIES` gains `.instar/subscription-pool.json`.

## What to Tell Your User

My list of which Claude or Codex logins live on which machine is now kept separately on each machine. A second machine no longer inherits the first one's login locations, and a login that only exists on the other machine is left off this machine's list. Nothing is deleted on any other machine.

## Summary of New Capabilities

None user-visible — the per-machine store the spec already promised is now populated automatically on update.

## Evidence

- `tests/unit/subscription-pool-legacy-migrate.test.ts` (7): publish + witness binding + legacy removal; tracked copy kept; refusals; recovery (finalize, rebuild from matching source, fail closed on a mutated source); pool-level drop/keep and persist-to-authority.
- `tests/unit/PostUpdateMigrator-subscription-pool-machine-local.test.ts` (3): tracked / untracked / no-repo; idempotent.
- `tests/e2e/subscription-pool-lifecycle.test.ts`: production update path + server boot serve only this machine's logins.
- 166 related unit files pass.

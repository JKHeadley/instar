# Side-Effects Review — migrateBackupManifest (pr-gate state paths)

**Version / slug:** `pr-gate-phase-a-commit-5-backup-manifest`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required — data-model migration only, no block/allow or session lifecycle surface`

## Summary of the change

Adds `migrateBackupManifest()` to `PostUpdateMigrator`. On next `npm update`, every migrated agent's `config.json` gains six pr-gate-related entries under `config.backup.includeFiles` via set-union (user entries preserved). Once persisted, the `BackupManager.constructor` (plumbed in commit 2) reads these and unions them with `DEFAULT_CONFIG.includeFiles` on every snapshot — so pr-pipeline event logs, debounce queues, cost ledgers, and the security audit log become durable across sessions and git-synced to paired machines. (`.instar/secrets/pr-gate/…` paths never reach the snapshot because commit 1's `BLOCKED_PATH_PREFIXES` guard refuses them at write time; this commit explicitly flags any secrets-path entry in `includeFiles` as a warning for defense-in-depth.)

Files touched:
- `src/core/PostUpdateMigrator.ts` — new `migrateBackupManifest()` method; inserted into `migrate()` after `migratePrPipelineArtifacts` and before `migrateGitignore`.
- `tests/unit/PostUpdateMigrator-backupManifest.test.ts` — new file; 8 tests covering missing config.json, fresh add, user-entries-preserved union, idempotency, secrets-path warning, malformed-entries tolerance, non-array-backup recovery, temp-file cleanup.

Atomic write is explicit: open temp-file → write → fsync → close → rename. Crash between any two steps leaves either the prior config.json intact (rename not executed) or the successor config.json intact (rename succeeded). Never leaves a torn write.

This is commit 5 in the Phase A landing of `docs/specs/PR-REVIEW-HARDENING-SPEC.md`. Spec lines 381-424 call for exactly this set of entries and semantics.

## Decision-point inventory

- **Set-union merge** — mechanical data-model operation. Not a judgment.
- **Secrets-path warning** — structural check (`path.normalize(entry).startsWith('.instar/secrets/')`) on each merged entry. Writes to `result.errors` for visibility but does NOT block the write — the authoritative defense is `BackupManager.BLOCKED_PATH_PREFIXES` at snapshot time (commit 1), and preventing the entry from reaching `includeFiles` here would require halting migration for an error the BackupManager will refuse anyway. Warning-not-block matches signal-vs-authority: the migrator is a signal emitter; the BackupManager is the authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable.

The secrets-path warning records `result.errors` but does not refuse the write. A user who had intentionally put a secrets path in `includeFiles` (unusual but not impossible) gets their config updated anyway; the entry simply has no effect because `BackupManager.BLOCKED_PATH_PREFIXES` skips it at snapshot time. The warning is correct guidance without being a blocker.

Non-string entries in an existing `backup.includeFiles` array (corrupted config, e.g., a stray number or object) are filtered out by the `typeof === 'string'` guard — this IS a rejection of legitimate data, but the "legitimate data" here is malformed: if anything non-string is in `includeFiles`, BackupManager would throw at snapshot time or produce undefined behavior. Filtering is the safer shape than preserving garbage.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable.

Related failure modes out of scope:
- A paired machine could replicate a config-json with a secrets path via git-sync, and the warning would only surface on each machine's own migration pass. The authoritative defense (BackupManager.BLOCKED_PATH_PREFIXES) still catches the snapshot attempt per-machine.
- The migrator can't detect a user's intent to REMOVE a pr-gate entry. Set-union re-adds anything the user manually deletes. Users who need to opt out can add the entry to `config._instar_noMigrate` (the existing opt-out mechanism in `applyDefaults`). If that becomes a real need we'll wire it up; for Phase A it's not required — there is no sensible reason an agent would opt out of pr-gate observability.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `PostUpdateMigrator` is the existing location for config-and-file migrations that run at `npm update` time. `migrateConfig` already handles config.json-level defaults via `applyDefaults`. `migrateBackupManifest` extends this pattern but with explicit set-union semantics on one specific array field — cleaner as its own method than conflated into `migrateConfig`'s deep-merge logic (which treats arrays as opaque leaves and would either overwrite or not-touch the array, neither of which matches the required set-union).

The choice to persist to `config.backup.includeFiles` (rather than teach BackupManager to read a hardcoded list at startup) is deliberate: the BackupManager constructor already unions user config with defaults (commit 2's plumbing). Persisting into config.json means paired machines see the same list via git-sync, and future migrations (adding new pipeline state files) follow the same set-union pattern.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface on judgment decisions. The secrets-path warning is explicitly a SIGNAL (logged in `result.errors`, does not halt migration); the authoritative defense lives at `BackupManager.BLOCKED_PATH_PREFIXES` (commit 1), which blocks the write at snapshot time. This matches the principle: detectors emit signals, authorities block.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** runs after `migrateConfig` (which applies SHARED_DEFAULTS including `backup: { includeFiles: [] }`) and after `migratePrPipelineArtifacts`. Neither of those writes to `config.backup.includeFiles`, so no shadow.
- **Double-fire:** none. Single migration call.
- **Races:** atomic write (temp → fsync → rename) guarantees no torn writes vs. the server process reading the config. `loadConfig` reads `config.json` synchronously; `rename` is atomic on POSIX → either old or new content is observed, never partial.
- **Feedback loops:** `BackupManager` reads `config.backup.includeFiles`; the migrator writes it. But the migrator runs at update time, not at every backup; and BackupManager doesn't write back. No loop.
- **Interaction with `applyDefaults`:** `applyDefaults` treats arrays as opaque leaves — if `config.backup.includeFiles` exists, it's left alone; if missing, it's added as `[]` (empty). Either way, when `migrateBackupManifest` runs, the field is either missing (treated as `[]`) or a (possibly-empty) array — both handled. The deep-merge logic doesn't see the post-migrate contents, so there's no opportunity for `applyDefaults` to clobber what we just wrote.
- **Interaction with `BackupManager.BLOCKED_PATH_PREFIXES`** (commit 1): complementary. Migrator-level assertion is a warning; BackupManager is the hard block. Both fire for any secrets-path entry. Belt-and-suspenders.
- **Interaction with `BackupConfig.includeFiles` union semantics** (commit 2): direct — this migrator's output IS the user-side half of the union that commit 2 computes at `BackupManager` construction time.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none.
- **Users of the install base:** first migration appends 6 entries to `config.backup.includeFiles` and logs one line to the upgrade summary. Subsequent migrations: idempotent no-op (skipped).
- **Git-sync:** on the next git-sync push, the updated `config.json` propagates to paired machines. Paired machines' migrations are idempotent — nothing reactive is triggered by the config-json change itself.
- **External systems:** none.
- **Persistent state:** `config.json` gains an array field (or extends an existing one). No new files.
- **Timing:** O(n) merge + O(m) secrets-path check where n and m are small (< 20 typical). Sub-millisecond.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code revert. Specifics:
- Migrator reverts to prior `migrate()` sequence without `migrateBackupManifest`.
- Test file deleted.
- Already-migrated agents retain the 6 pr-gate entries in their `config.backup.includeFiles`. Harmless: `BackupManager` simply includes those paths in snapshots going forward; if the files don't exist (early phases), `resolveIncludedFiles` silently skips them.
- Users who want a clean revert can manually `jq` the entries out of `config.json`; the reverted migrator will not re-add them.
- No data migration, no user action required. Estimated rollback effort: one commit revert, one patch release.

---

## Conclusion

A minimal, idempotent data-model migration that persists six pr-gate state paths into `config.backup.includeFiles`. Set-union preserves user entries. Atomic write via temp-file + fsync + rename. Secrets-path warning emits as signal for defense-in-depth; BackupManager remains the authoritative block. 8 new tests pass, all adjacent migrator suites (PR-pipeline artifacts + skillPortHardcoding + sharedState + telegramReply + gitignore — 47 tests) unaffected. tsc clean.

Clear to ship as Phase A commit 5 of 8.

---

## Second-pass review (if required)

Not required.

---

## Evidence pointers

- Source: `src/core/PostUpdateMigrator.ts` — `migrateBackupManifest()` method added; `migrate()` sequence extended.
- Tests: `tests/unit/PostUpdateMigrator-backupManifest.test.ts` — 8 tests, 50ms.
- Type check: `npx tsc --noEmit` — clean.

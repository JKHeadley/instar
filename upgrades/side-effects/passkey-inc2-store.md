# Side-Effects Review — Agent-held passkey store + secrets-tree exclusions (Increment 2)

**Version / slug:** `passkey-inc2-store`
**Date:** `2026-09-22`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (credential custody + backup/sync exclusion changes)`

## Summary of the change

Increment 2 of the approved spec `docs/specs/agent-held-google-passkey.md` (§3.1 custody):

- **New `src/core/PasskeyCredentialStore.ts`.** A separate encrypted store at
  `.instar/secrets/passkeys/store.enc`, using the shared vault's AES-GCM envelope and master key,
  with HMAC entry keys and a cross-process `proper-lockfile` lock (read-modify-write, verified by
  read-back). It adds:
  - the machine-scope guard in `load()`;
  - quarantine, release, adoption records, remove with tombstone;
  - an encrypted pending record for crash-safe minting, with a 24h expiry sweep;
  - a names-only `index.json`.

  Nothing constructs the store yet; wiring comes in later increments, so there is no runtime
  behaviour change from it alone.
- **`SecretStore`** gains an optional `storeFile` (a relative path; defaults to the shared vault)
  and now writes through a unique temp file instead of the fixed `.tmp`.
- **Closing a pre-existing backup gap.** `BackupManager.BLOCKED_PATH_PREFIXES` gains the
  stateDir-relative `secrets/`. The existing entry was the project-relative `.instar/secrets/`, but
  `includeFiles` entries are resolved relative to stateDir. So `includeFiles: ['secrets/passkeys/']`
  or `['secrets/config.secrets.enc']` was copied into snapshots (reproduced by a probe before the
  fix). This covers the shared vault as well as passkeys.
- **`WorkingSetManifest.computeWorkingSet`** refuses any candidate under `<stateDir>/secrets/`,
  counted as a jail rejection. Before this, a journal row or interactive-artifact record pointing at
  a file under secrets/ would have been carried to another machine.
- **Gitignore.** `DEFAULT_GITIGNORE` gains `secrets/`, and `PostUpdateMigrator.migrateGitignore`
  adds `secrets/` to `.instar/.gitignore` and `.instar/secrets/` to the project `.gitignore` for
  existing agents (idempotent).

## Decision-point inventory

- `PasskeyCredentialStore.load` machine-scope guard — add — invariant: provenance + quarantine + adoption record.
- `BackupManager` deny list — modify — adds the stateDir-relative `secrets/` prefix.
- `computeWorkingSet` candidate filter — modify — refuses the secrets tree.

---

## 1. Over-block

- A user who deliberately listed `secrets/…` in backup `includeFiles` loses those files from new
  snapshots. That is intended: the secrets tree was always meant to be excluded, and the existing
  comment says so.
- The working-set carrier can no longer move a file under secrets/. Nothing legitimate should have
  been doing that.
- Gitignoring `.instar/secrets/`: the vault is not tracked in any agent home we know of (it shows
  as untracked on Echo). If some agent had committed it, `.gitignore` does not un-track it, so there
  is no data loss.

## 2. Under-block

- The store protects against accidents, not against same-user code (spec §1.1, an accepted risk).
- An older snapshot taken before this fix may still contain secrets; this change doesn't scrub
  existing backups. Restoring such a snapshot is already filtered by `isDeniedForBackup` on restore,
  which now includes `secrets/`.

## 3. Level-of-abstraction fit

Custody lives in its own module beside `SecretStore` and reuses its envelope, adding one optional
field rather than new crypto. Exclusions are applied at the existing chokepoints: the backup deny
list, the working-set jail, and gitignore migration.

## 4. Signal vs authority compliance

The machine-scope guard and the exclusions are deterministic invariants over provenance and paths,
not detectors judging content. Each can only withhold something; none can act.

## 4b. Judgment-point check (Judgment Within Floors standard)

Invariants (spec §10 "Machine-scope guard in `load()`"). There are no competing signals.

## 5. Interactions

- The unique temp-file name in `SecretStore.write` changes nothing for single writers, and removes a
  collision if two processes ever write the vault at once. The pre-existing lost-update race on the
  shared vault itself is not fixed here; the spec records that separately.
- `isDeniedForBackup` is also applied on restore, so a restore now skips `secrets/` files in old
  snapshots. That is the right direction.
- The working-set `jailRejected` count rises for any secrets candidate. It is already surfaced as a
  count, and that is correct.

## 6. External surfaces

Backups get smaller for any agent that had included secrets paths. There is no user-visible message
and no new route.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface in this increment.

## 7. Multi-machine posture (Cross-Machine Coherence)

- The passkey store, pending records and index are machine-local by the operator-ratified exception
  (spec §12, FD2).
- This change also enforces that locality in the two replication paths that could otherwise carry
  them: backups (which git-sync replicates) and the working-set carrier.

## 8. Rollback cost

Revert the code. The new store file, if one were created (nothing creates it yet), would simply sit
unused. The gitignore lines are harmless if left behind. Reverting the backup prefix would re-open
the gap, so it shouldn't be reverted on its own.

---

## Conclusion

The custody foundation is in place and inert until later increments wire it up. The work also closed
two real exclusion gaps: backups of a stateDir-relative secrets path, and carrier nomination of
secrets files. The backup gap existed before this spec and affected the shared vault. Clear to ship
after the second-pass review.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Round 1: concern.** Six points, all addressed:
1. Leftover output from an earlier buggy run of the multi-process test (8 folders named after test
   emails, holding test-only file master keys) was sitting in the worktree. Deleted before staging;
   the child processes now receive their paths through environment variables, not argument positions.
2. Two processes creating an absent store could each mint a different hashing key. Creation now
   happens under a lock on the passkeys folder (the same lock every write takes), with a re-check
   inside the lock. A barrier-synchronised six-process test FAILS with the lock removed and passes
   with it (each confirmed twice).
3. `remove()` after a machine-id change reported success while the record under the old id stayed on
   disk. It now deletes every record for the email under any machine id and returns `removedKeys` and
   read-back-verified flags.
4. The pending-record sweep treated "unreadable" as "expired" and deleted it. It now never deletes an
   unreadable record and reports it (`{removed, unreadable}`).
5. `release` and `commitAdoption` now verify by read-back, and `commitAdoption` refuses records that
   are not `legacy-adopted`.
6. The backup prefix check and the working-set refusal now ignore case (macOS disks are
   case-insensitive); a `Secrets/…` spelling is covered by a test.

**Round 2: concur.** All six fixes confirmed in code; no new blocking issue. Two minor notes recorded
for the increment that wires the store in: `writePending`/`deletePending` run outside the directory
lock, and `remove()`'s `tombstone` flag reflects this machine's key only (the `entryAbsent` flag is
what covers every machine id).

---

## Evidence pointers

- `tests/unit/passkey-credential-store.test.ts` (16 tests, including two multi-process tests —
  concurrent writers and concurrent first-time creation — each verified to FAIL with the lock removed
  and to pass with it).
- `tests/unit/passkey-secrets-exclusions.test.ts` (backup refuses 7 spellings of secrets paths —
  reproduced as leaking before the fix; the file viewer refuses 5 paths including a case-variant; the
  default gitignore covers `secrets/`).
- `tests/unit/WorkingSetManifest.test.ts` new case (verified to FAIL without the fix).
- `tests/unit/PostUpdateMigrator-gitignore.test.ts` new idempotent migration case.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `novel` would overstate it; this is a path-spelling mismatch in a deny list
  (project-relative vs stateDir-relative). It isn't an agent-authored-artifact defect (prompt, hook,
  config, skill or standards text), so: not applicable. The guard that prevents recurrence is the
  new exclusion test, which exercises every relative spelling through the real `createSnapshot`.

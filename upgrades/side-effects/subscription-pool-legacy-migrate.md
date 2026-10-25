# Side-Effects Review — subscription pool: legacy shared file → per-machine authority

**Version / slug:** `subscription-pool-legacy-migrate`
**Date:** `2026-10-06`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Spec `docs/specs/subscription-pool-authority-foundation.md` (converged 2026-08-27, approved by Justin) defines the per-machine authority store and names "PostUpdateMigrator (legacy single-file staged migration)" as a changed file — but that migration was never built: the witness type carries `legacy-migrate`, nothing wrote it. Meanwhile instar#2122 showed the cost: the legacy `.instar/subscription-pool.json` was shared between Luna's laptop and Studio through the agent home's git repo, so the Studio inherited the laptop's login locations and its sessions used `/Users/justin/...` paths.

1. `SubscriptionPoolAuthorityStore.migrateLegacy(root, { removeLegacy })`: publishes the authority from the validated, untouched legacy source; the witness is `legacy-migrate` bound to the source's SHA-256 + size; staging under `subscription-pool.candidate-legacy-<gen>`; cleanup of staging/witness on failure. `recoverLegacyMigrate` implements the spec's recovery table (finalize committed directory; rename complete staging; rebuild from a byte-matching source; fail closed on a mutated/missing source).
2. `SubscriptionPool.migrateLegacyToMachineLocal({ removeLegacy })`: reads the legacy file, drops rows whose `configHome` does not exist on this machine (reported), publishes the rest. `persist()` now writes to the authority whenever a published generation was loaded, even if a legacy file is still on disk (before, load read the authority but persist would have written the legacy file — a divergence).
3. `PostUpdateMigrator.migrateSubscriptionPoolToMachineLocal`: adds `.instar/subscription-pool.json` to the agent home's `.gitignore`; runs the migration once per machine; removes the legacy file only on git's POSITIVE "not tracked" answer (`git ls-files --error-unmatch` via `SafeGitExecutor.readSync`, tri-state: tracked / untracked / unknown — a missing repo, a refused source-tree guard or any other failure is `unknown` and keeps the file). `migrateSubscriptionPoolInteractiveReady` now reads the authority when one is published (machineId-aware pool) instead of gating on the legacy path. `GITIGNORE_ENTRIES` gains the same entry for new homes.

**Deliberate deviation from the spec's "remove matching legacy":** a git-tracked legacy file is left in place. Deleting it would be committed by the agent home's git-sync and propagate to every peer on its next pull; a peer that has not yet migrated would lose its only copy. The authority wins on load and persist, so the lingering shared copy is inert. Removal of tracked copies is a later step once every machine of an agent has migrated.

## Decision-point inventory

- Which rows are published: `fs.existsSync(configHome)` on this machine.
- Whether the legacy source is removed: git-tracked or not.

## 1. Over-block

A row whose login home is temporarily unavailable at migration time (unmounted volume) is dropped from this machine's authority; the legacy file (kept when tracked; removed when untracked) still lists it, and re-enrollment restores it. Rows are never deleted anywhere else.

## 2. Under-block

A peer that pulls a `.gitignore` change gains the ignore entry but keeps tracking the file until a later release untracks it. Luna's Studio has already untracked its copy by hand; the laptop's copy is still tracked.

## 3. Level-of-abstraction fit

Store-level protocol in the authority store (where first-create and update live); row filtering in the pool (which knows the account shape); git/ignore handling in the migrator (the documented path for existing agents).

## 4. Signal vs authority compliance

No decision authority over agent behaviour; a data-store migration. The migration only ever ADDS the per-machine authority; it deletes a legacy file only when untracked and byte-matching the witness.

## 4b. Judgment-point check

Not a competing-signals decision: file existence, git tracking and digest equality are facts.

## 5. Interactions

- `load()` already preferred the authority; `persist()` precedence is corrected to match.
- Existing `migrateSubscriptionPoolInteractiveReady` still reads the legacy path to find claude homes; it runs on the authority-less pool and is unaffected.
- Quota polling, swaps and enrollment read the pool; after migration they see only this machine's homes — the intended fix for #2122.
- E2E: the production update path + server boot on a home with a legacy file serves only this machine's logins over `/subscription-pool`.

## 6. External surfaces

Migration log lines name published/dropped account ids (never credentials). `.gitignore` gains one entry.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN per the approved spec (login locations live on one disk; `machineId` witness, `foreign-authority` refusal). Account METADATA replication for pool-scope views is the existing WS5.2 projection and is untouched.

## 8. Rollback cost

Revert the code; the authority directory and witness remain on disk and the previous release ignores them (it reads the legacy file, which was kept when tracked). For an untracked, removed legacy file the prior release would see an unconfigured pool until re-enrollment; the authority directory holds the data.

## Conclusion

Builds the migration the approved spec already called for, with one safety deviation (never delete a shared copy) that closes the #2122 cross-machine inheritance without risking a peer's data.

## Second-pass review (if required)

Independent subagent reviewer, 2026-10-06. **Two concerns raised, both fixed:** (1) a crash-recovery rebuild republishes the WHOLE legacy source and the pool then answered `already-machine-local`, so foreign homes would have stayed published under this machine's id — now, while the witness operation is still `legacy-migrate`, the next migration pass re-applies the home filter with an `update()` (test: rebuild → prune → no-op); (2) `isGitTracked` returned `false` on any error, including the source-tree guard refusing `ls-files` on an agent home that is the instar checkout, which would have forced removal — now tri-state, and only git's own "not tracked" answer permits removal (test: no repo → kept). Also noted and fixed: `migrateSubscriptionPoolInteractiveReady` skipped forever once an untracked legacy was removed — it now reads the published authority. Concurred on witness/sibling conformance, `persist()` precedence, deletion safety (digest+size-gated unlink only; recovery never deletes), and the `configHome` filter. The spec's "then remove matching legacy" is deliberately not applied to a tracked copy (recorded above).

# Side-Effects Review — imported history excluded from git sync

**Version / slug:** `imported-history-never-syncs`
**Date:** `2026-11-18`
**Author:** `echo (easy setup, topic 143810)`
**Second-pass reviewer:** `independent general-purpose reviewer (fresh context, given the diff only)`

## Summary of the change

Imported Claude/ChatGPT history (`<stateDir>/imported-history/`, written by `ImportedHistoryStore`) is excluded from git sync and from git. A new constant file `src/core/importedHistoryPaths.ts` names the folder once. It feeds `ImportedHistoryStore` (the folder it writes), `FileClassifier` `DEFAULT_SECRET_PATTERNS` (never-sync, checked before every other class), `MachineIdentity` `GITIGNORE_ENTRIES` (the project `.gitignore` for new agents, written by all init paths through `ensureGitignore`), and `GitStateManager` `DEFAULT_GITIGNORE` (the internal state repo's `.instar/.gitignore`). `GitStateManager.init()` also appends the line when a `.instar/.gitignore` already exists without it, which closes a gap on one init path that the reviewer found. `PostUpdateMigrator.migrateImportedHistoryGitignore` adds the line to existing agents' `.gitignore` files on update (Migration Parity). Tier 1 by declaration. The change is about 40 lines across 5 source files plus one new constant file and one new test. Effort: one review round and one follow-up check of the fix.

## Decision-point inventory

- `FileClassifier.classify` never-sync list — modify — one more directory prefix classed as never-sync.
- `GitStateManager.init` gitignore write — modify — appends one line to an existing file when it is missing.
- `PostUpdateMigrator` gitignore migrations — add — one idempotent step, existing files only.

---

## 1. Over-block

A user file elsewhere in the project can't be refused, because the pattern is the exact `.instar/imported-history/` directory prefix. `FileClassifier.matchesPattern` also accepts `/.instar/imported-history/` deeper in a path, which only matches the same folder spelling. The test checks that `.instar/imported-history-notes.md` is not refused.

---

## 2. Under-block

- **Collapsed untracked folder.** When git status collapses an entirely untracked `.instar/` into one line, the classifier sees `.instar/` and does not refuse it. In that case the `.gitignore` line is the guard: new agents get it from the templates and existing agents from the migration. This gap is older than this change and applies to every never-sync entry.
- **Already-tracked files stay tracked.** The migration does not untrack files git already tracks. No `.gitignore` change can do that. The importer merged today (2026-11-18), and the two machines that run it had no imported-history folder when this was written. The classifier still refuses to stage new changes to those files.
- **Other `git add -A` callers** (`HandoffManager`, `BranchManager`, `nuke`) rely on the `.gitignore` lines alone. New agents and updated agents both have those lines.

---

## 3. Level-of-abstraction fit

This uses the existing lists at the layer they already guard: the classifier for git sync, `.gitignore` for plain git, and the migrator for existing agents. No new mechanism was added. The shared constant stops the store and the lists from drifting apart.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface beyond a static path list.

This is a fixed exclusion of a private-data folder, which is a safety floor. It is an enumerable invariant ("this folder never leaves the machine"), not a judgment between competing signals.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The rule is an invariant: this folder never syncs.

---

## 5. Interactions

- **Git sync conflict resolution** resolves never-sync files to the local copy, so nothing comes in from a peer.
- **Deletions** are still staged on purpose. Staging a deletion can't leak content.
- **Backups and the file routes** are not touched here. History-acquisition work (#3387) covers them separately.

---

## 6. External surfaces

- Agents' `.gitignore` files gain one line, on update and at init.
- No routes, configs or messages change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. Imported history stays on the machine where it was imported, and git sync no longer carries it to peers. Status surfaces: none changed.

---

## 8. Rollback cost

A revert restores the old lists. Lines already added to agents' `.gitignore` files stay, and they are harmless. No data migration.

---

## Conclusion

The folder is excluded at every layer that decides what git carries: never-sync in the classifier, both new-agent templates, the state-repo init path, and the update step for existing agents. Tests run the real code.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer (fresh context, given the diff and the goal only)
**Independent read of the artifact: concur**

Round 1 verdict was concur-with-nits. It confirmed that the classifier path covers git sync staging, the conflict handling and absolute and relative inputs. It found one real gap: an init path leaves `.instar/.gitignore` with project-relative lines, and `GitStateManager.init()` kept that file. That gap is fixed and tested, and the reviewer re-checked the fix. The other nits are recorded above under Under-block.

## Evidence pointers

- `tests/unit/imported-history-never-syncs.test.ts` (7): store folder = shared path; never-sync for relative and absolute paths; neighbour not swept up; both templates; real `git init` leaves the history untracked; migration idempotent and creates no files.
- Related suites passed: file-classifier, machine-identity, identity-autoaccept-storage-manifest, PostUpdateMigrator-a35-remediationPaths (188 tests); git-state-manager 40/40; security + passkey-secrets-exclusions 32. `tsc --noEmit` is clean.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.

## Merge with main (2026-11-18 09:0x PST)

Main moved when #3424 merged; both sides had added an entry to the Stage-B exclusion list in `src/data/stageBCertifiedSet.ts`. Resolution keeps all three entries (this PR's `importedHistoryPaths.ts`, main's `boundedInput.ts` and `standing-authorization.ts`). No behaviour change. Typecheck clean; imported-history-never-syncs + stage-b-evidence-code-binding 27/27.

# Side-Effects Review — addGitignoreEntry helper + .instar/secrets/pr-gate/ entry

**Version / slug:** `pr-gate-phase-a-commit-3-gitignore-pr-gate`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required — no block/allow surface, no session lifecycle, no gate/sentinel/watchdog`

## Summary of the change

Adds an idempotent `addGitignoreEntry()` helper to `PostUpdateMigrator` and extends `migrateGitignore()` to call it with `.instar/secrets/pr-gate/` against the project-level `.gitignore`. On the next agent update, every migrated agent gains an explicit exclusion of the pr-gate secrets directory from its project git repo — a belt-and-suspenders defense paired with commit 1's `BackupManager.BLOCKED_PATH_PREFIXES` guard. The helper is pure file I/O: reads `.gitignore`, checks for an active-line (non-comment, non-blank) match, writes only when the entry is absent. File-not-exists, empty file, missing trailing newline, and commented-out-reference cases are all handled explicitly.

Files touched:
- `src/core/PostUpdateMigrator.ts` — new private method `addGitignoreEntry()`; `migrateGitignore()` extended to call it with the pr-gate entry.
- `tests/unit/PostUpdateMigrator-gitignore.test.ts` — new test file with 9 cases: 6 direct helper tests (file-not-exists, empty file, missing trailing newline, idempotency, commented-out-reference safety, blank-line safety) and 3 migrateGitignore-level tests (fresh add, idempotent re-run, existing-entries preserved).

This is commit 3 in the Phase A landing of `docs/specs/PR-REVIEW-HARDENING-SPEC.md`. Spec line 425 calls for exactly this helper shape ("idempotent; no-op if entry exists") and this one .gitignore entry.

## Decision-point inventory

- **None added.** `addGitignoreEntry` is a mechanical content check — "does this exact-match active line already exist in this file" — with a mechanical append on the negative branch. It holds no block/allow authority and produces no signal consumed elsewhere.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable.

The helper has two outcomes for any input: entry already present → skip; entry absent → append. Neither outcome rejects any legitimate user content. The only thing "rejected" is the redundant re-adding of an entry that is already present, which is the intended idempotent behavior.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable.

Out-of-scope limitations (not failures of this helper, but adjacent to its purpose):
- The .gitignore entry prevents accidental `git add`; it does not prevent a user from using `git add -f` or a contributor from committing the file through a different working tree. The BackupManager.BLOCKED_PATH_PREFIXES guard (commit 1) and the pre-commit gate (Phase A commit 4+) are the defenses for those paths.
- The helper only adds to the project-level `.gitignore`. The `.instar/.gitignore` (GitStateManager's internal tracking gitignore) is untouched. For the pr-gate threat model, project-level coverage is sufficient: `.instar/secrets/pr-gate/` is never intended to reach the project repo. If a future requirement demands exclusion at the internal-git layer, a second call-site addition would cover it.
- Non-literal pattern matching: the helper does exact-string match on `.trim()`ed lines. A user who had `.instar/secrets/` (parent directory) already ignored would still get `.instar/secrets/pr-gate/` appended redundantly, because the helper does not reason about gitignore pattern subsumption. This is intentional — reasoning about gitignore semantics is out of scope, and the redundant entry is harmless (git still treats it as ignored).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `PostUpdateMigrator.migrateGitignore()` is the existing, single-responsibility place for one-shot `.gitignore` edits during agent migration. The existing `removeGitignoreEntry` private helper establishes the precedent of gitignore-edit helpers living as private methods on the migrator; `addGitignoreEntry` is the symmetric counterpart. No higher-level gate is appropriate — gitignore edits are migrator-bound operational concerns, not judgment-level decisions. No lower-level primitive exists.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface. It is a mechanical file-content update: read file, check for active-line match, append on absence.

Narrative: per `docs/signal-vs-authority.md`, the principle applies to judgment decisions. `addGitignoreEntry` makes no judgment — it answers a structural question ("is this exact entry already a non-comment non-blank line") and performs a data-model mutation (append). The BLOCKED_PATH_PREFIXES and future pr-gate authorities remain the defenses that actually classify content; this helper just ensures one specific path is not in the set of files `git add .` would stage.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** none. `migrateGitignore()` already runs in a well-defined spot within the migration sequence; adding one more call at the end does not shadow any existing removal or any existing addition (there are no other additions today). The new `addGitignoreEntry` call runs AFTER the two existing `removeGitignoreEntry` calls, which is the correct order — removals first (clean up stale state), additions second (install new state).
- **Double-fire:** none. The migration runs once per `npm update`. Re-running inside a single migration pass would be idempotent by construction.
- **Races:** none within a single migration run. Concurrent migrations on the same agent are prevented by the existing PostUpdateMigrator run-lock. No shared in-memory state is mutated.
- **Feedback loops:** none. `.gitignore` is a static file consumed by git, not by any instar subsystem that could feed back into the migrator.
- **Interaction with `removeGitignoreEntry`:** the two helpers operate on separate entries and do not touch each other's lines. Both trim-match; neither would falsely flag the other's entry as present.
- **Interaction with `BackupManager.BLOCKED_PATH_PREFIXES` (commit 1):** complementary. Commit 1 defends the backup → git-sync path (prevents secrets from being snapshotted). This commit defends the direct `git add` path (prevents secrets from being staged in the project repo at all). Both run independently; neither depends on the other.
- **Interaction with `GitStateManager`:** GitStateManager uses `.instar/.gitignore` internally, which this helper does NOT touch. No interaction.
- **User edits to `.gitignore`:** a user who has previously commented out the pr-gate entry (e.g., `# .instar/secrets/pr-gate/`) would have the helper add the active-line form on next migration. A user who had intentionally commented it out to _allow_ staging would see their intent reversed. Judgment: this is a secrets-protection entry, and the risk calculus favors secrets-defense over rare opt-out scenarios. Any user who genuinely needs to stage `.instar/secrets/pr-gate/` can use `!.instar/secrets/pr-gate/specific-file` whitelisting in the same `.gitignore`, which the helper leaves untouched.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none. The migrator runs per-agent.
- **Users of the install base:** on the next `npm update`, every migrated agent's project-level `.gitignore` gains a single new line: `.instar/secrets/pr-gate/`. The migrator logs one line (`project .gitignore: added .instar/secrets/pr-gate/`) to the upgrade summary. First-time-update visibility: users will see this line in their migration log. Subsequent updates: no change (idempotent).
- **External systems:** none. Does not touch Telegram, Slack, GitHub, Cloudflare, or any external service.
- **Persistent state:** `.gitignore` gains one line on first migration. The change is persistent (the next `git commit` will include the updated `.gitignore` if the user stages it; even if not staged, future git commands will honor the new exclusion).
- **Git history:** the next `git status` after migration will show `.gitignore` as modified. Users who are in the habit of not committing tool-generated gitignore edits can leave it unstaged; users who accept the edit will have a new line in their project `.gitignore`.
- **Timing:** the helper runs in O(n) where n is the number of lines in `.gitignore` (typically < 100). Negligible impact on migration time.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change on the migrator. `git revert` the commit and ship as next patch. Specifics:

- The helper disappears from `PostUpdateMigrator` on revert.
- The `migrateGitignore` call-site extension reverts to its prior two-call form.
- The test file is deleted.
- Already-migrated agents retain `.instar/secrets/pr-gate/` in their project `.gitignore`. This is harmless — the entry simply continues to be honored by git, excluding the pr-gate secrets directory from staging. No regression, no cleanup required. Future migrations (post-revert) would not re-add it, but also would not remove it (there is no `removeGitignoreEntry` call against this entry).

Estimated rollback effort: one commit revert, one patch release. Zero operational complexity. Zero data migration.

---

## Conclusion

Adds a minimal, idempotent gitignore helper and wires one `.instar/secrets/pr-gate/` entry into the migrator sequence. No decision points, no authority, no interaction with existing gates. Tests cover the six non-trivial branches of the helper's logic plus three call-site behaviors. All 9 tests pass; adjacent PostUpdateMigrator test suites (24 tests across sharedState/skillPort/telegramReply) unaffected. tsc clean.

Clear to ship as Phase A commit 3.

---

## Second-pass review (if required)

Not required. Commit touches no block/allow surface, no session lifecycle, no compaction/respawn, no coherence/idempotency/trust gate, and no sentinel/guard/watchdog module. Per `/instar-dev` Phase 5 criteria, second-pass is only mandatory for those classes of change.

---

## Evidence pointers

- Source: `src/core/PostUpdateMigrator.ts` — `migrateGitignore()` extension at existing function body; `addGitignoreEntry()` new private method immediately after.
- Tests: `tests/unit/PostUpdateMigrator-gitignore.test.ts` — 9 cases (6 helper-direct, 3 call-site).
- Test run: `npx vitest run tests/unit/PostUpdateMigrator-gitignore.test.ts` — 9 pass, 8ms.
- Regression sweep: `npx vitest run tests/unit/PostUpdateMigrator-sharedState.test.ts tests/unit/PostUpdateMigrator-skillPortHardcoding.test.ts tests/unit/PostUpdateMigrator-telegramReply.test.ts` — 24 pass.
- Type check: `npx tsc --noEmit` — clean.

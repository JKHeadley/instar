# Side-Effects Review — deleted files in decision-audit scope

**Version / slug:** `decision-audit-deleted-scope`
**Date:** `2026-11-07`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 2 scripts, about 40 lines, plus tests. One review round, first commit attempt counted in the PR body.

`scripts/instar-dev-precommit.js` listed staged files with `--diff-filter=ACMR`, so deleted paths never reached a decision record, and a deletion-only commit exited before the gate. `scripts/decision-audit-presence-check.mjs` takes every changed path and requires coverage, so a PR deleting an in-scope file could never pass. PR #2821 is stuck on that (`scripts/run-migration.js`).

The hook now reads a second list, `--no-renames --diff-filter=DT`, and adds it to `inScopeFiles` only. `staged` stays as it was, so every check that reads staged content is untouched. The record's `scope.basis` gets a new value. The checker excuses a deleted (`D`) uncovered file only if some record in the PR carries the old basis with a readable file list.

Every use of the staged list was read. Uses of `staged` (audit report scan, artifact/ELI16 staged checks, operator surface checks) need existing files and are unchanged. Uses of `inScopeFiles`: `git diff --numstat` and `git diff` with pathspecs (tolerate deleted paths), `classifyTier` and `selfActionDeclarationVerdict` (path strings and diff text only, no file reads), trace coverage (path strings), `assertFrameworkGenerality` (reads the artifact, not the paths), and the audit record. `write-trace.mjs` does not check that `--files` exist.

## Decision-point inventory

- commit gate scope (`instar-dev-precommit.js`) — modify — deletions, rename sources and type changes must be covered by the trace and enter the record.
- merge-time decision-audit check (`decision-audit-presence-check.mjs`) — modify — one narrow excuse for deleted files under old-basis records.
- `safe-merge.mjs` body checks — pass-through — it already maps `removed` to `D`.

---

## 1. Over-block

A commit deleting an in-scope file now needs a trace listing that path; before it needed nothing. That is the intended tightening, and the refusal says deleted and renamed-away paths count. `git revert` and merges do not run the hook at all, so they are unchanged; a revert made with `--no-commit` and then committed does run it. A branch mixing old-basis and new-basis records still gets the excuse, so in-flight work is not stranded.

---

## 2. Under-block

A PR can still delete a file in a bypassed commit and pass if it carries any old-basis record. New records never carry that basis, but the excuse also accepts a historical record the PR happens to modify, and a `verdict: blocked` one, and one such record excuses every deletion in the PR. That is acceptable: the check detects a skipped gate and is not a security boundary, since anyone able to touch a record could already list the path. The excuse stays in the checker on purpose; it costs one line and nothing has to come back for it. The reverse case: a branch with only old-basis records and a type-changed in-scope file would stay stuck, because only `D` is excused. None of the 60 newest open PRs has one. Rename targets outside the scope were never checked and still are not; the rename source now is.

---

## 3. Level-of-abstraction fit

Right layer. The writer owns what a record lists and the checker owns what it requires. The fix makes the writer match the checker, and keeps a transition rule in the checker for records that can no longer be rewritten. Hand-editing the #2821 record or giving it a new head was rejected: the first is forbidden, and the second throws away a clean verify and depends on the same fix.

---

## 4. Signal vs authority compliance

Both are existing deterministic checks of structured file lists, the shape `docs/signal-vs-authority.md` allows: no judgment about meaning. This change adds no new blocking authority of a brittle kind; the checker gets one narrower case, and the hook's existing coverage rule sees more paths.

---

## 5. Interactions

`class-closure-lint`, `defect-class-registry` and `DefectClassRegistry.ts` read decision records but not `scope.basis` or `scope.files`. The only reader of `scope.files` is the presence check; nothing reads `basis` but the check. `files` (the count) grows by the deleted paths, which only feeds audit review. The tier classifier sees deleted paths, so deleting a safety file can raise the risk floor: correct. A rename now has both paths in the diff pathspec, so git pairs it: a moved file counts only its changed lines in numstat and `addedDiffText`, where it used to count as all new. Moved, unchanged code therefore no longer trips `assertSelfActionDeclared` or the new-capability signal. That is a narrow loosening, and more accurate, since the code did not change. Other lints keep their own `ACMR` lists because they read content.

---

## 6. External surfaces

None at runtime. No agent or user sees a change. `safe-merge` runs from the installed package, so the new checker takes effect on the merge watcher only after a release. Builders see a stricter trace requirement for deletions.

---

## 7. Multi-machine posture

Machine-local by design: a commit hook and a merge check read git state, which is identical on every machine. Records ride the commits. No durable state, no notices, no URLs.

---

## 8. Rollback cost

A revert. Records with the new basis stay valid under the old checker, because it ignores `basis`. No migration, no agent state.

---

## Conclusion

Ship it. The writer now matches the checker, the excuse is narrow and disclosed, and #2821 passes on its real data without a new head.

## Second-pass review

Concern raised: the logic is correct, but the refusal a builder actually sees does not say what this artifact and the ELI16 say it does, and two other claims here are inaccurate. None of these blocks the fix for PR #2821.

**Must fix**

1. Section 1 says the refusal "names the path and says deleted paths count". The ELI16 says "the refusal says so". Neither holds on the path a builder hits. A trace that leaves out a deleted path fails the search at `instar-dev-precommit.js:411`, so the hook stops at `:422-425` with the generic "No fresh complete trace covers this staged change". The new wording at `:598` sits in the Step 5 loop, which only runs once some trace covers every path. Run in a sandbox with `src/gone.ts` left out of the trace: exit 1, the new wording appears 0 times, and the path appears only in the list of all in-scope files. Put the hint in the `:424` message, or correct both documents.
2. Section 1 says a revert commit "gets the same treatment". It does not. `git revert`, with or without the editor, ran pre-commit 0 times in a sandbox with a passing control (plain commit 1 run, `git revert --no-commit` then commit 1 run). `git cherry-pick` also ran it 0 times, though that run had no separate control. A revert that deletes an in-scope file gets no gate and no record, so on a current-basis branch the PR fails until it is recommitted through the hook. Modified files already behave this way, so this is not new, but the sentence is wrong.

**Should disclose**

3. Adding rename sources changes the rename numbers, and the Summary implies nothing changed. With both paths in the pathspec, git pairs them: a 20-line file renamed with one added line went from `21 0` to `1 0` in numstat. Moved lines also leave `addedDiffText`, so the size signal shrinks and `assertSelfActionDeclared`, which can block, no longer fires on moved code. That looks like the better behavior, but it is a narrow loosening and belongs in section 2.
4. Section 2 says only branches cut before this change can produce the old basis. New records, yes. But the excuse also accepts any old-basis record in the PR's changed files: a modified historical record counts (`safe-merge.mjs:515` keeps every status except removed), and so does a `verdict: blocked` record. One such record excuses every deleted file in the PR. This is acceptable under the "not a security boundary" reasoning, but the claim should be narrowed. Nothing tracks removing the excuse once old branches drain.

**Confirmed**

- No consumer of `inScopeFiles` reads those paths as files: `classifyTier`, `selfActionDeclarationVerdict`, `assertFrameworkGenerality`, `traceMissingCoverage` and `blockCommit` use path strings only. `verifyProposalDerivedRunbooks` and `assertOperatorSurfaceQuality` receive `staged`.
- The excuse is correct on both sides: `D` matches exact status only, `removed` maps to `D`, and an unreadable record gives `{}` and excuses nothing.
- A rename that drifts across the PR reads as `D` plus `A`, which is the case `--no-renames` handles.
- The new checker passes #2821 on its live files and records. Of the 60 newest open PRs, 57 pass and 3 fail, all 3 for carrying no record at all, which is unrelated.
- Remaining stuck case: an old-basis PR with a typechange, because only `D` is excused and safe-merge maps `changed` to `M`. No checked PR has one.
- Section 5's reader claims hold: nothing else reads `scope.files` or `scope.basis`.
- Signal vs authority: compliant. These are structural checks on file lists, and the hook's existing coverage rule simply sees more paths.

Re-review: Concur with the review. All four concerns are resolved in the current files: replaying the omitted-deletion case now prints the hint at `instar-dev-precommit.js:424` (the `:598` wording is gone, and the test asserts the new text), and sections 1, 2 and 5 and the ELI16 now match what I measured. One wording nit remains, not blocking: the comment at `decision-audit-presence-check.mjs:52-55` still says the excuse "ends with" old branches, which is looser than section 2.

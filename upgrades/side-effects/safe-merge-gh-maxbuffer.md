# Side-effects review — safe-merge gh output ceiling + code-owner approval read from reviews

**Tier 1.** 1 script file (+13/-4 lines), 1 new test file. Effort: no spec rounds, first commit attempt.

## Summary

`scripts/safe-merge.mjs` spawned `gh` with Node's default 1 MiB `maxBuffer`. A large PR's
`pulls/N/files --paginate --slurp` answer (every file's patch) exceeded it, `gh` was killed with
ENOBUFS, and safe-merge refused the merge as `refused:contexts-unverifiable` (PR #2364: 94 files,
1.6 MB diff). Fix: every `gh` spawn uses one named option set with `maxBuffer: 256 MiB`. The
`gh()` helper is now exported and takes an injectable `spawn` (default `spawnSync`) so the test
can drive it with a real >1 MiB child process. No other behaviour changes. I considered
narrowing the file reads with `--jq` to filenames, and did not: `--slurp` cannot be combined
with `--jq`, so it would change the output shape that `checkLocalFloor`'s injected `ghJson`
(and its tests) parse, which is more than this fix needs.

## 1. Over-block
None. The change removes a false refusal; it adds no refusal.

## 2. Under-block
An answer above 256 MiB would still overflow and be refused as unverifiable, the same safe
direction as before. No real PR approaches that.

## 3. Level-of-abstraction fit
Right layer: the spawn options are the cause, and one shared constant covers all three gh
spawns, so a future call site has an obvious thing to reuse.

## 4. Signal vs authority compliance
No decision logic changes. safe-merge keeps its existing authority; this only stops a transport
failure from being misread as an unverifiable check. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions
The green-PR watcher and Local Verify merge line call safe-merge; they now get a real verdict
on large PRs instead of `contexts-unverifiable`. Memory: the buffer is a ceiling, not an
allocation; a normal answer uses what it needs.

## 6. External surfaces
None for users or other agents. GitHub sees the same requests.

## 7. Multi-machine posture
Machine-local by design: a CLI run on whichever machine merges; no state.

## 8. Rollback cost
Revert the commit. No state, migration or config.

## Second-pass review
Concur with the review.
- All three `'gh'` spawns (gh() at the helper, mergeAndConfirm, the auto-merge arm) use GH_SPAWN_OPTIONS; ghJson, ghText and fetchChecksRows all route through gh(), so the large `--paginate --slurp` reads (files, check-runs, workflow runs) are covered. The only other spawns (node for authToken, sleep) read tiny output.
- Exporting gh and adding the optional `spawn` param changes no CLI behaviour: every internal caller omits it and gets spawnSync. The isCliEntry guard is untouched, and the module was already imported by other unit tests without running main().
- Test runs green (4/4): test 1 shows the default buffer really ENOBUFS on 3 MiB, test 2 drives the real gh() with its real options through a >1 MiB child, test 3 keeps spawn errors throwing, test 4 pins every gh spawn to the shared options.
- The 8 answers are accurate (+13/-4 confirmed; `--slurp` with `--jq` is indeed rejected by gh api).


---

# Second change in this PR — code-owner approval read from the reviews

**Tier 1.** 1 script file (~+110/-6 lines), 1 new test file (17 tests). Effort: no spec rounds.

## Summary

The main-branch ruleset requires a code-owner review with `required_approving_review_count: 0`.
With a required count of 0, GitHub never sets `reviewDecision` (it stays empty), even after the
code owner approves. safe-merge refused any code-owned PR unless `reviewDecision === 'APPROVED'`,
so every PR touching `docs/STANDARDS-REGISTRY.md` or `.github/CODEOWNERS` was unmergeable forever
(PR #2389: JKHeadley approved head 6648d9f10, decision `""`, refused `refused:approval-required`).

Fix: only when code-owner review is required, owned files are touched, AND `reviewDecision` is
empty (null/undefined/""), safe-merge reads `pulls/N/reviews` and passes only if every owned file
has, among its user owners (last matching CODEOWNERS rule), one whose LATEST
APPROVED/CHANGES_REQUESTED/DISMISSED review is APPROVED on the current pinned head. The PR author
and the authenticated gh account running the merge never count. Team/email owners are not
resolved; a file owned only by them stays refused with reason `owner-unresolvable`. Any set
decision (APPROVED, REVIEW_REQUIRED, CHANGES_REQUESTED) behaves exactly as before.

## 1. Over-block
An approval on an older commit never counts, even when `dismiss_stale_reviews_on_push` is off
(GitHub would accept it there). That is stricter than GitHub, the safe direction; the remedy is a
re-approval. Team-only owners still refuse (named reason) instead of guessing membership.

## 2. Under-block
On the normal path, if GitHub's own rule disagrees, GitHub refuses the merge call and the existing
merge-refusal path reports it. On the `--admin` path, an account that can bypass the ruleset is
NOT re-checked by GitHub, so this precheck is the only gate there; it therefore models what GitHub
would count: approvals on the current head only, author and merging account excluded, and the
approver must have write access (`repos/.../collaborators/<login>/permission` is admin/maintain/
write; unreadable → refuse), since GitHub ignores a code owner without it. Still unmodelled: team
membership (refused, not guessed) and CODEOWNERS syntax errors (CODEOWNERS is read from the base
branch, so a PR cannot rewrite its own owners). A reviewer whose login is excluded only by being the PR author is still excluded when
`gh api user` is unreadable (author is always excluded).

## 3. Level-of-abstraction fit
Right layer: the false refusal is in safe-merge's review precheck, and the fix lives beside
`codeOwnerReviewPending`, reusing the CODEOWNERS parse and `codeOwnedFiles` already used there.

## 4. Signal vs authority compliance
safe-merge's authority is unchanged in kind: it still refuses unless approval is evidenced. The
new logic is deterministic over GitHub's own review records (not brittle text matching), and it
can only ever loosen a refusal that GitHub's empty decision made unanswerable; GitHub's server-side
ruleset remains the final authority on the merge. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions
Green-PR watcher and the Local Verify merge line call safe-merge; code-owned PRs the owner approved
now proceed to the remaining gates (local-verify record, checks). The `--auto` arm path does not
run reviewPrecheck and is unaffected. One extra `gh api` read for reviews and one for `user` happen
only in the empty-decision code-owned case, plus one permission read per counted approver.

## 6. External surfaces
GitHub sees two extra read requests in that case. No change for users or other agents.

## 7. Multi-machine posture
Machine-local by design: a CLI run on whichever machine merges; no state.

## 8. Rollback cost
Revert the commit; code-owned PRs return to being unmergeable by the tool. No state or config.

## Second-pass review (code-owner change)

Concern raised: the code is sound, but answer 2 (Under-block) overstates the backstop. It says "nothing merges that GitHub refuses", yet the default (non-`--auto`) path ends in `mergeAndConfirm(... admin: args.admin)`. When `--admin` is passed and the merging account is a ruleset bypass actor, GitHub does not re-check the code-owner rule, so this precheck is the only gate. The logic below holds up as that only gate. The answer should say so plainly and drop the claim that GitHub catches anything this check misses. One gap is unmodelled: GitHub ignores a CODEOWNERS user who lacks write access, and this check would count that user's approval. The risk is low because CODEOWNERS is read from the base branch, which the owner controls. It should still be named in answer 2.
- A set reviewDecision behaves as before: the new branch runs only when `isEmptyReviewDecision` is true (null, undefined or ""). APPROVED never enters the block. REVIEW_REQUIRED and CHANGES_REQUESTED reach the original `refuseApprovalRequired` call unchanged. In the empty case the new `refuseApprovalRequired` exits (`process.exit(1)`), so the second call is never reached and no case falls through.
- Head binding: `pinnedHeadFor` = `args.matchHeadCommit ?? view.headRefOid`. main() already refuses `head-moved` when the two differ, and the merge itself passes `--match-head-commit pinnedHead`. So an approval on head X can only ever merge X. A missing head is refused (`head-unknown`).
- No self-approval: the PR author is always excluded, and the gh viewer is excluded when `gh api user` can be read. Logins are compared case-insensitively, which is correct because GitHub logins are case-insensitive. A CODEOWNERS owner token must match `^@[A-Za-z0-9-]+$`. Teams (`@org/team`), emails and bot logins never count as users, so a file owned only by them refuses with `owner-unresolvable`.
- Latest-state semantics: PENDING and COMMENTED reviews are filtered out, and DISMISSED counts as a revoke. Reviews are sorted by `submitted_at`. A missing `submitted_at` sorts first and cannot override a later dated review. JS sort is stable, so undated ties keep API (chronological) order.
- CODEOWNERS: last-match-wins in `ownersForFile`, the same rule `codeOwnedFiles` applies. Rules are read from the BASE ref, so a PR that edits CODEOWNERS cannot grant itself an owner. Every owned file needs its own owner's approval. A file with no owned changes cannot pass (`ownedFiles.length > 0`).
- Reviews pagination: `--paginate --slurp` returns an array of page arrays, and `.flat()` handles that (same shape as the existing files read). gh failures throw from `ghJson`, and both callers map the throw to `refused:contexts-unverifiable` (try/catch at the local-floor call and the cross-check call). Being stricter than GitHub on stale approvals is the safe direction. The earlier ruleset precheck is unchanged, so last-push-approval stays governed by it.
- 17/17 tests in tests/unit/safe-merge-code-owner-reviews.test.ts pass locally. Answers 1 and 3–8 are accurate.

Re-review after fix: Concur with the review. Write access is now enforced in code. An approval counts only when `canWrite(login) === true`. `canWrite` defaults to "no", and the production code passes it as `hasWriteAccess`, which requires admin, maintain or write and refuses when the permission cannot be read. The permission read happens only for an approval on the current head that is not excluded. Answer 2 now correctly names this precheck as the only gate on the `--admin` bypass path, and answer 5 counts the extra permission read. The new test and the wiring check pass.

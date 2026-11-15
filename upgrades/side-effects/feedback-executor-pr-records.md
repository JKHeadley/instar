# Side-Effects Review — feedback executor PRs carry a decision record and a release fragment

**Version / slug:** `feedback-executor-pr-records`
**Date:** `2026-11-14`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Feedback-executor fix PRs could never merge: the Actions floor fails `decision-audit` (no `.instar/instar-dev-decisions/*.json` record, because the executor's commit never passes the local instar-dev pre-commit gate) and `release-fragment` (no `upgrades/next/*.md`). Live: #3159 and #3168 passed the executor's independent review and sat at `merge-deferred`.

New `src/feedback-factory/execute/prRecords.ts` builds both records from trusted data; `FeedbackExecutorService.publish()` appends them to the session's change set immediately before `applyChangeSet` into the publish clone (both the normal path and the PIN-approved held path go through `publish`). `prText` now also returns the record inputs (summary, test files and name, related-tests outcome). The decision record says `source: "feedback-executor"`, `localPrecommitGate: "not-run"`, lists the checks the executor ran with their real outcome and the ones that did not run, and carries `scope.files` = every decision-audit in-scope path in the change set (deleted ones included) with a basis value other than the legacy one. The fragment has the four required sections. Spec drafts and changes with nothing in scope get no records.

Files: `src/feedback-factory/execute/prRecords.ts` (new), `src/feedback-factory/execute/FeedbackExecutorService.ts` (import, `PrText` type, `prText` return, `publish` append), tests, spec §4 step 8 amendment, ELI16, release fragment.

Tier 1 (2 source files, ~200 LOC, no new authority). Effort: one build pass, one commit.

## Decision-point inventory

- Executor publish step — modify — adds two trusted files to the published tree. No allow/deny decision changes.
- `decision-audit` / `release-fragment` CI checks — pass-through — unchanged; executor PRs now satisfy them.
- Independent review — pass-through — reviewers now also see the two record files in the diff (small, trusted text).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change only adds files.

---

## 2. Under-block

No block/allow surface. Residual gaps, stated plainly: the records make the two presence checks pass, they do not make the executor run the instar-dev side-effects review; the decision record says so (`notRun`). The other failing checks on #3159/#3168 (Docs Coverage, Unit shard 1/4, Integration) were red on main at the same time (`route 54% < 55%` docs-coverage floor; `tests/integration/test-runner-bound-meta.test.ts` (d2)), so executor PRs still wait for main to be green, like every PR.

---

## 3. Level-of-abstraction fit

Right layer: the publish step is the only trusted code that builds the commit, and it already composes the PR title, body and commit message. Writing the records in the confined session would let untrusted code author the audit record (and `.instar/` is a held tooling path there by design). The scope predicates mirror `isInScopeFile` / `isReleaseRelevant`; a unit test imports the real scripts and fails on drift, so the mirrors cannot silently diverge. Importing the `.mjs` scripts from `src/` would put CI scripts in the shipped build.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It writes records; the existing CI checks keep their authority unchanged.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The path predicates are mirrors of existing CI predicates (enumerable path rules), checked against them by test.

---

## 5. Interactions

- Secret gate runs before publish on the PR title/body/notes; the records only contain the triage summary (already in the PR body) and trusted metadata, so they expose nothing the gate did not see. For a PIN-approved held set, the same text the operator approved in the body appears in the records.
- Spec review head (`isSpecReviewHead`) requires exactly one file: spec PRs get no records (tested).
- `codeownersOutsideApprover` now sees the record paths too; CODEOWNERS covers neither path.
- A session file at the same `upgrades/next/feedback-…-a<n>.md` path is overwritten by the trusted one (applied last). The session cannot write `.instar/` at all (sandbox deny + tooling hold).
- `class-closure-lint` reads `classClosure` from decision records; ours is `null`, the same as most hand-made records (report-only path).
- Open PR #3135 also edits `FeedbackExecutorService.ts`; this diff touches only `prText`'s signature/return, the `publish` signature and two lines in its body, plus one import and one type line, to keep the conflict surface small.

---

## 6. External surfaces

Executor PRs on GitHub gain two files. Merged executor fixes now produce a release-note entry and a patch bump in the next release (previously such a PR could not merge at all). The fragment's "What to Tell Your User" line reaches agents' upgrade notices; it is a fixed sentence plus the sanitized summary.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the executor runs on the lease holder only; the records are written into that attempt's publish clone and travel in git. No new durable local state.

---

## 8. Rollback cost

Revert the PR; executor PRs go back to lacking the records (and to not merging). No migration, no state repair. Already-merged records are inert history files.

---

## Second-pass review

**Reviewer:** independent general-purpose subagent (given the diff and the CI scripts, not this artifact's conclusions)

Round 1: Concern raised. (1) A doubled `:`/`=` after a camelCase word survived the one-pass scrub, so a fragment could fail `upgrade-guide-validator.mjs` at publish time. (2) TODO/FIXME was matched with a leading `\b`, but the validator's check has none (`myTODO`). (3) The record could print test-name text beyond the 200 characters the PR body carries (which the secret gate scans). Nit: the secret-gate label could say which outcome applied.

Resolution: the scrub now consumes every separator run, TODO/FIXME is matched with no leading boundary, testName is cut to 200 characters before flattening, and the secret-gate result is `pass` or `held-then-operator-approved` from `operatorDecisionRef`. A new test covers each one.

Round 2: **Concur.** All three concerns and the nit are fixed. The reviewer re-ran the two test files (135 tests passed) and `tsc --noEmit` (clean).

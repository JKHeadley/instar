# Side-Effects Review — feedback executor merge path (first merge)

**Version / slug:** `feedback-executor-merge-path`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (a revert fully undoes it). Three files of source changed (`executorPorts.ts`, `FeedbackExecutorService.ts`, the new `publishEvidence.ts`), plus tests. No feedback-executor PR has ever merged. A live trace on 2026-11-15 found three blockers:

1. `GhGateway.removeLabel` read GitHub's 404 "Label does not exist" as a failure. Once the first admitted merge attempt removed the `hold` label and safe-merge deferred, every later tick failed to remove the already-gone label and `reconcilePr` returned before `safeMerge`. Evidence: `logs/feedback-triage.jsonl` shows `execute:gh-unknown … what:"remove-label"` every 30 minutes for PRs 3159, 3168 and 3195. Their rows sat at `merge-deferred:checks-pending` with merge deadlines a day past. Fix: that exact 404 means done. Every other failure stays a failure.
2. `decision-audit`, a required Actions-floor context, failed on every executor PR. The publish clone commits with hooks off on purpose (HARDENED_GIT_CONFIG), so the instar-dev pre-commit gate never writes a record. Fix: the trusted publisher writes `.instar/instar-dev-decisions/<ts>-<branch-slug>.json` with `gate: 'feedback-executor'`, the in-scope changed paths, and `declaredTier: null`, an honest statement that the tier machinery did not run.
3. `release-fragment` failed on every executor PR. safe-merge refuses any red check (`refused:red-checks`; a diagnostic run on PR 3195 printed `failed: release-fragment, decision-audit, instar/local-verify`). Fix: when the change set ships runtime files, the publisher adds `upgrades/next/<branch-slug>.md` in fixed wording, with only counts, the trusted feedback id and no file names. Release notes are read by every agent on update, so nothing the confined session controls reaches them. Any `upgrades/next/` or `upgrades/NEXT.md` entry the session wrote is dropped before publication (audited as `execute:session-release-notes-dropped`). Before this change a session-written note would have gone out as-is.

Not changed: fork-only publication. The brief suggested same-repository branches. Two specs keep fork-only on purpose: feedback-triage-and-execution §4 ("fork-only publication … unchanged") and local-verify-merge-authority L14 (the executor's cross-repo PRs stay on the Actions floor). CI on a same-repository branch runs with repository secrets (ci.yml uses one on push) before any review of code generated from untrusted text. Fork PRs merge on the Actions floor, and local-verify mirrors that.

Effort: one build round plus one revision from the second-pass review; one commit attempt.

## Decision-point inventory

- `removeLabel` result: consumed by `reconcilePr` (unchanged logic). Only the classification of one GitHub answer changes.
- No new gate. The two files are data, judged by the existing CI checks and by the independent reviewers at the head.

## 1. Over-block

No issue identified. Nothing new refuses anything.

## 2. Under-block

- PRs with real test failures (3159, 3168 and 3199 have red unit or integration shards) still do not merge. That is correct: safe-merge refuses red checks, and those items go through the existing refusal, retry and park path.
- `needsReleaseNote` is wider than `release-relevant-paths.mjs` (for example a non-shipped `skills/*.md`). That only adds an unneeded patch-note line.

## 3. Level-of-abstraction fit

Right layer. The publisher is the only trusted code that holds the publish clone. The confined session is barred from `.instar/` (isToolingPath), so it cannot write the record. And it should not be trusted to write the record's scope anyway.

## 4. Signal vs authority compliance

Complies. No blocking authority is added. The record is evidence the existing decision-audit check reads. The 404 classification is a narrow, exact match on GitHub's documented answer. A wrong match would only let the existing merge step run, and that step keeps every floor (admitted head, `--match-head-commit`, the full Actions floor).

## 4b. Judgment-point check

Not a competing-signals decision point.

## 5. Interactions

- decision-audit-presence-check: the record's basis is never the excused pre-deletion basis, and deleted paths are listed. The unit test runs the real checker on both sides.
- class-closure lint (report-only): `classClosure: null`, the same as records written before declarations existed.
- check-release-fragment and upgrade-guide-validator: the unit test runs both on the generated fragment.
- Independent review: the reviewers read the PR diff at the head, which now includes both files. The review prompt treats them like any other change.
- Changeset cap: the files are added after the cap check and are small (under 2 KB).

## 6. External surfaces

Executor PRs now carry two more files. Each released executor fix adds one patch-note section with fixed user-facing text.

## 6b. Operator-surface quality

No operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The executor runs only on the lease owner (canonical-owner check). Records and fragments travel inside the PR and git, so there is no state to replicate.

**Status surfaces:** `execute:pr-opened` audit rows gain an `evidence` list of the paths written.

## 8. Rollback cost

Revert the PR. Already-merged records and fragments are ordinary repository files.

## Conclusion

Ship. These three changes remove every blocker the trace found that stops a passing fix from merging. The fix-quality failures stay where they belong, on the existing refusal path.

## Second-pass review

Independent reviewer (general-purpose subagent, given the code and the spec, not my conclusion). **Concern raised:** (1) medium: the first version skipped its own note when the session had written one, so the confined session could author release notes. (2) low: file names can carry instruction-like words. Otherwise concur: `labelAlreadyAbsent` is narrow; the record is honest; the held/secret path, spec PRs, deleted files and `wx` are fine; fork-only matches the specs.

**Resolution:** both fixed. The publisher drops every session-written release-note path (`withoutSessionReleaseNotes`), and the note carries counts only. New tests cover a session-written `upgrades/next/session.md` with injected text: it is not pushed and the text appears nowhere in the pushed tree. They also check that a suggestive file name is not listed. The reviewer also noted the e2e fake calls `labelAlreadyAbsent` directly; the real `GhGateway` path is covered by the unit test with a fake `gh`. **Reviewer concurred after fixes: yes (both concerns addressed as the reviewer proposed).**

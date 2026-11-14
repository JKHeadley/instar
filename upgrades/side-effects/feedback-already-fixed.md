# Side-Effects Review — already-fixed reports held after one attempt

## Summary of the change
Files: `src/feedback-factory/execute/executorSession.ts` (result field `fixedByCommit`, prompt sentence and result-shape line), `src/feedback-factory/execute/executorPorts.ts` (optional `AttemptGit.commitInBase`, implemented in `SafeAttemptGit` with two local git reads), `src/feedback-factory/execute/FeedbackExecutorService.ts` (not-reproducible branch and `afterFailure`), tests (`execute-service`, `execute-units`, `execute-github-runtime`, harness fake), spec + ELI16 amendments. Tier 1: about 120 lines, reversible by revert, no state or config migration. Measured cause: 3 items used 7 sessions in two days, each session naming the same earlier fix.

## Decision-point inventory
`afterFailure` (when an item is parked) gains one branch: a session claim that trusted code verifies → hold `already-fixed` now. No new block on publication; a hold only pauses an item, and new reports bring it back.

## 1. Over-block
A session can name a commit that is in the base but did not actually fix the report (wrong attribution). This is weaker evidence than today's rule: one session's attribution instead of two sessions' failures to reproduce. Trusted code bounds it two ways: the commit must be in the attempt's base, and it must have been committed after the item's first report (a commit that predates the report cannot be its fix, which rules out naming the root commit or any old history). A misattribution inside that window parks a real defect one attempt early; new reports reopen it, and the hold is graded `wrong` (weak) on the work decision.

## 2. Under-block
No change to what reaches a PR. A claim without a commit, or with one the base lacks, follows the old path (one retry, then hold `not-reproducible`).

## 3. Level-of-abstraction fit
Right layer: the executor already owns retry and hold. Triage has its own `already-fixed` reason (with a PR from the item's merged list); this is the executor-side counterpart for a fix triage missed, and it reuses the existing hold.

## 4. Signal vs authority compliance
The session's attribution is the signal; the deterministic local checks (`rev-parse --verify <sha>^{commit}`, `merge-base --is-ancestor <full> <baseSha>`, committer time after the first report) bound which claims can count, but do not prove the commit fixed the report. The resulting authority is only a reversible hold, undone by new reports or the operator's release (`docs/signal-vs-authority.md`).

## 5. Interactions
`commitInBase` is optional on the port; fakes without it (integration/e2e fixtures) keep the old behavior. The commit string is validated as 7–40 lowercase hex before reaching git, and git runs in the trusted source checkout via `SafeGitExecutor.readSync` with no network. The episode counter still increases, so a second held episode (after new reports) blocks the item as before. Audit event `execute:already-fixed-claim` records the claim and the verified full SHA or null.

## 6. External surfaces
None outside the operated host: fewer executor sessions, held items show reason `already-fixed` in the triage summary. Dev-gated (`feedbackFactory.execute`).

## 7. Multi-machine posture
Machine-local by design: the executor and its source checkout live on the operated host.

## 8. Rollback cost
Revert and release. Items already held `already-fixed` stay held until new reports or an operator release, like any hold.

## Second-pass review
**Reviewer:** independent general-purpose subagent, 2026-11-12, given the code rather than my conclusion. Pass 1 concerns: ancestry alone lets a session name any old commit (even the root), so one misread `git log` parks a real defect after one attempt; the artifact overstated the evidence ("same judgment as two claims", "deterministic"); a null source path reached git as the server's working directory. All changed: the commit must also be committed after the item's first report (tested both sides), §1 and §4 now state the weaker evidence, and a missing source path skips the check. Pass 2: Concur. It notes the remaining, named weakness: a commit made after the first report that fixes something else still passes; that costs at most one early hold, undone by new reports or the operator's release.

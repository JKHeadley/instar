# Side-Effects Review — related-test failures compared against the unchanged base

## Summary of the change
Files: `src/feedback-factory/execute/FeedbackExecutorService.ts` (related-tests gate in `verifyFix`, PR text), `src/feedback-factory/execute/executorSession.ts` (two pure helpers: `vitestFailureKeys`, `failuresAllPreexisting`), tests in `tests/unit/feedback-factory/execute-service.test.ts` and `execute-units.test.ts`, spec + ELI16 amendments. Tier 1: one gate branch, reversible by revert, no state or config. About 150 lines. Measured cause: the confined related run denies `listen` (`allowLocalBinding: false`), so route tests fail with EPERM at head regardless of the fix; 9 of the last 25 attempts ended `gate:related-tests`, none reached a PR.

When the related run exits non-zero (not timed out, no limit), the executor reads the run's JSON report (new `--reporter=json --outputFile.json` into a trusted per-run report folder) plus the printed "originated in" lines, keys each failure as `file::test`, `file::<suite>` or `file::<unhandled>`, and re-runs just those files on a never-used fresh base clone (no attempt bytes) under the same sandbox. If every head key is also a base key, the gate result is "inconclusive: preexisting" and the attempt proceeds to the secret gate, review and PR with that stated in the PR text. Otherwise it fails as before.

## Decision-point inventory
The related-tests gate (an existing blocking check in trusted executor code) gains one narrow pass-through: failures shared with the unchanged base. No new block. The later authorities are unchanged: two-model independent review, the owner's approval of the exact head, and the full CI floor that safe-merge requires before merge.

## 1. Over-block
Still fails a fix when the base run hits a limit (the base files can be slow) — conservative; a timed-out base gives no evidence. Still fails when a failure names no file (e.g. a crash with no report), as before.

## 2. Under-block
A real regression inside a test that also fails at base for another reason (same key) is masked here; CI on the head, which has no sandbox and so no EPERM, still runs that test before merge. The related run executes attempt test code, so its JSON report and printed output are attempt-controlled, the same standing as its exit code (attempt code can already exit 0): it could name only failures the base shares and hide the rest. The baseline side cannot be forged by the attempt: it runs in a clone path no earlier run used (`-reference`), so no process left behind by attempt test code holds write access to it, and its report goes to a folder trusted code creates under `-reports/`, outside the attempt's temp directory (which the attempt session could write), writable only by that one baseline run. Failure keys must be plain paths inside the clone (absolute, `..` and option-shaped paths are dropped). CI and two-model review remain the backstops.

## 3. Level-of-abstraction fit
Right layer: the gate already owns "is this failure the fix's fault", and the timed-out "inconclusive" path from 2026-11-07 is the same shape. Loosening the sandbox (`allowLocalBinding: true`) was rejected: on macOS it also admits outbound connects to any localhost port, which would let attempt code reach the agent server and other local services.

## 4. Signal vs authority compliance
Narrows a brittle block using evidence (a controlled comparison), does not add one. Authority to merge stays with CI + review + owner approval (`docs/signal-vs-authority.md`).

## 5. Interactions
Adds up to one more confined run per failing attempt (only the failing files, bounded by the 45 min related limit) under the host test-runner limiter. Uses two new attempt paths, `-reference` (baseline clone) and `-reports` (report folders); both are removed in the check's finally block and in attempt cleanup. The baseline uses the same default vitest config as the head's `vitest related` run. Audit events: `execute:related-tests-failed` (with up to 20 failure keys — previously no detail was logged), `execute:related-tests-preexisting`.

## 6. External surfaces
PR text for a fix that passed this way says some related tests failed and also fail on the unchanged code. More executor PRs can open on the fork; existing caps (max open PRs 4, starts per day) bound that. Dev-gated feature (`feedbackFactory.execute`), operated host only.

## 7. Multi-machine posture
Machine-local by design: the executor runs only on the operated host that owns the attempt.

## 8. Rollback cost
Revert and release. No state, config or data migration.

## Second-pass review
**Reviewer:** independent general-purpose subagent, two passes on 2026-11-12, given the code rather than my conclusion. Pass 1 concerns: the reports sat in the attempt's temp directory, which the attempt session could still write, so a left-behind process could forge the baseline report; the baseline reused the base clone where attempt test code had run; failure keys accepted `..` and absolute paths; the baseline used per-lane configs while the head used the default. All four were changed: per-run report folders under `-reports/` writable only by their own run, a never-used `-reference` clone, unsafe keys dropped, the default config on both sides, and §2 now says the related report is attempt-controlled. Pass 2: Concur. Its one unchecked assumption, that the session's write rule for the attempt folder does not cover `-reports`/`-reference` by name prefix, I checked in the real sandbox-runtime CLI: a write to the sibling folder is refused (`Operation not permitted`). Also checked there: a `listen` test fails with `EPERM`, and vitest writes its JSON report into a read-denied, write-allowed folder.

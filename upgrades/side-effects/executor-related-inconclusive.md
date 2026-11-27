# Side-Effects Review — Executor related inconclusive

**Version / slug:** executor-related-inconclusive
**Date:** 2026-11-07
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 2, 1 runtime file, one spec sentence and unit coverage, about 10 runtime lines. Tier 2 because it changes a check before publication. A related-tests time limit with no failure printed no longer fails verification, and the PR text says so. Amends docs/specs/feedback-triage-and-execution.md. Effort: no spec rounds.

## Decision-point inventory
- `verifyFix` related-tests gate — modify: time limit with no printed failure becomes inconclusive; failure, printed failure and output cap still stop.

## 1. Over-block
Removes an over-block: discarding a fix over a slow optional run.

## 2. Under-block
A PR can open without the related tests finishing, and a test that hangs forever because of the fix reaches a PR; independent review and the merge floor then apply. The floor is safe-merge's pinned Actions contexts on the head, fail closed. It is not the complete suite: CI's unit job excludes 122 flaky-listed files (91 under tests/unit/threadline), so a fix that breaks one of those can merge after an inconclusive run and be caught only by the post-merge main verify, where Local Verify runs. It does not test the exact merge either; the related run did not before. The failure-output match is a text heuristic on partial output and can miss a failure vitest had not printed yet.

## 3. Level-of-abstraction fit
Raising the limit would not bound a saturated machine. Skipping the run loses the early warning when it does finish.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. This narrows what a brittle timeout can decide. The merge floor keeps authority.

## 4b. Judgment-point check
None.

## 5. Interactions
`verifyFix`'s result only feeds publication, and nothing grades the related run. A killed process cannot reach the publish clone. Inconclusive runs add PRs against maxOpenPrs.

## 6. External surfaces
A new audit event, `execute:related-tests-inconclusive`. More PRs may reach review and the merge line.

## 7. Multi-machine posture
Machine-local BY DESIGN.

## 8. Rollback cost
Plain revert.

## Second-pass review
**Reviewer:** independent Claude subagent
Concern raised, then addressed. It traced the floor (see section 2), found my claim of "the complete suite on the exact merge" false, and found a printed failure before a timeout was ignored and the PR body would misstate the run. All corrected, with tests.

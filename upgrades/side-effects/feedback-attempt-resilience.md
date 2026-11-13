# Side-Effects Review — executor checks survive several restarts; open PRs are reviewed through restarts; extra test files no longer fail a fix

## Summary of the change
Files: `src/feedback-factory/execute/FeedbackExecutorService.ts` (restart recovery counts re-verifies in item meta, `MAX_REVERIFY_AFTER_RESTART = 3`; the base/head check builds its command from `filesNamingTest`), `src/feedback-factory/execute/executorSession.ts` (`filesNamingTest`), tests (`execute-service`, `execute-units`), spec + ELI16 amendments. Tier 1: about 50 lines of code, reversible by revert, no config. Based on main, independent of #3119 (both touch the same files; whichever merges second takes a small docs-only rebase). Measured causes: 54c2a4aa:a1 and :a3 ended `interrupted` by update restarts; :a2 failed `head-check:test-not-run-at-head` on an extra listed integration file.

## Decision-point inventory
(0) The stop path for an open PR under an older owner epoch: only an armed PR (`merge-armed`) is now a stop that defers re-gating to the next tick; a never-armed PR is disarmed as a no-op safety net, adopted, and goes on to its review in the same tick. The epoch moves on every server restart; on 2026-11-13 nine restarts in about two hours left #3129 unreviewed for five hours because every tick saw it stale. (1) Restart recovery: when a `verifying` attempt is found after a restart, it re-verifies up to 3 times instead of once. (2) The base and head checks: which listed test files run under `-t <testName>`. Neither changes what reaches a PR: every check still runs on the published bytes, and the related-tests gate, the independent review, owner approval rules and CI are unchanged.

## 1. Over-block
None added. Both changes only stop discarding attempts.

## 2. Under-block
(1) More re-verifies means an attempt whose checks keep being interrupted holds its claim longer (up to 3 more check runs, each bounded by the existing command limits) before it is stopped; it does not consume more daily starts. (2) Narrowing: a listed file without the named test no longer runs in the base/head check. That file's other tests were never the base/head check's subject (that check proves the one named test fails before and passes after); the related-tests gate still runs every test related to the changed sources, and CI runs everything. A session cannot use this to skip a failing test it wrote: the named test must still run and pass in each config run (chained exit codes and a passed count above zero per run), and the related-tests gate runs the rest.

## 3. Level-of-abstraction fit
Right layer: restart recovery already lives here (the once-only rule), and the base/head command was already built from the session's list. The alternative, making the restart hold refuse to yield to Local Verify, would trade merge throughput for executor throughput; re-running only the cheap checks avoids that conflict.

## 4. Signal vs authority compliance
No new authority. The session's `testFiles` list is narrowed by trusted code reading the published bytes, and falls back to the old list when nothing matches (`docs/signal-vs-authority.md`).

## 5. Interactions
Open-PR stop path: `reconcilePr` already adopts a stale row and re-gates it; the stop path no longer withholds a never-armed row from it. An armed PR under an older epoch is still disarmed and waits a tick, exactly as before. A failed disarm still keeps the row out of this tick. The re-verify counter lives in item meta (`exec:reverify:<attemptId>`); a row from before this change with reason `reverify-after-restart` and no counter counts as one re-verify used. The executor's restart hold still yields to Local Verify exactly as before. `execute:reverify` audit rows now carry `n`; a new `execute:test-files-narrowed` row records listed vs kept files.

## 6. External surfaces
None outside the operated host (dev-gated `feedbackFactory.execute`).

## 7. Multi-machine posture
Machine-local by design: the executor and its attempts live on the queue-owning host; the meta key is in its own store.

## 8. Rollback cost
Revert and release. Leftover `exec:reverify:*` meta keys are inert.

## Second-pass review
**Reviewer:** independent general-purpose subagent, 2026-11-13, given the code rather than my conclusion. Concur, with nits: the new constant had split an existing comment from its line (moved above it); §2 wording said "each file kept" where the check is per config run (reworded); the case where the name appears only in a comment of a kept file fails closed (no test runs, `head-check:test-not-run-at-head`) and has no dedicated test. It also noted `-t` is an unanchored regex, so a dropped file could hold a test matching by describe-plus-title without the literal text; such a file is then covered only by the related-tests gate and CI, which it judged acceptable. The counter write precedes the state change, so a crash between them uses up a retry and never loops. Pass 2 (open-PR stop path): Concur. Neither the old nor the new path checks which machine a row came from; both adopt under the current epoch, and the change moves the review from the next tick to this one, with arming still requiring a pass at the current head. The row is adopted before reconcilePr reads it, so the disarm runs once. An armed row or a failed disarm still waits a tick.

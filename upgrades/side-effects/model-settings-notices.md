# Side-effects review: model settings reconciliation notices

## Summary
Tier 1, SMALL, reversible bug fix. Runtime changes: orchestrator bookkeeping/equality and disclosure admission, direct-spawn expectation wiring, tier-shaped spawn record normalization. Tests cover unit decisions, HTTP spawn integration and real orchestration restart lifecycle. One independent review round, no spec convergence rounds; commit/gate attempts: 2 (the first refused a stale artifact digest after the review note was finalized; the digest was refreshed). Change size: 10 source/test/documentation files, approximately 300 code/test lines plus the required prose artifacts. Repair built in a fresh worktree from origin/main 09e59eb50, version 1.3.1679, origin https://github.com/JKHeadley/instar.git. A fresh clone hosts the worktree because the original common git directory is read-only.

## Decision points touched
Exact profile equality and duplicate disclosure admission are enumerable invariants, not competing-signals judgments. Existing idle, autonomous-run, protection, escalation and ownership authorities retain their responsibilities. New launch expectation is invalidated by accepted profile writes or changed pin axes/baseline.

## 1. Over-block
Suppresses erroneous default-drift notices and repeated disclosure of the same pending mismatch. Real explicit topic pins and per-topic config still reconcile. Only system busy deferrals lose the redundant twin; protected-session instructions and operator-write responses remain visible.

## 2. Under-block
Unknown legacy launch records remain unknown, never evidence to kill work. An unpinned inherited-default mismatch waits for natural spawn. That is intended launch policy, not an unapplied operator pin. A distinct requested profile may disclose again. Protection has a separate actionable notice.

## 3. Level-of-abstraction fit
The orchestrator owns expected-live comparison, boot reconciliation and pending retries. Direct-spawn helper supplies launch expectation at its existing single resolution point. No alternate messaging path or new recovery controller.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. Equality and durable duplicate admission are objective invariants on an existing informational disclosure. No new authority blocks user messages, kills sessions or changes protection. Existing idle-gated recovery remains the authority for restart timing.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. The invariant is equality of launch characteristics, unchanged baseline and semantic pin signature; profile writes explicitly end the override.

## 5. Interactions
Explicit launch preferences survive restart but expire on real profile writes; a cosmetic display change alone does not replace the model. Escalation overlay matching remains intact. Tier-shaped spawn records preserve null concrete model to avoid phantom divergence. Busy retry remains armed even when its disclosure was already claimed. Successful application clears the mismatch episode; boot sweep prunes gone topics and clears convergence. Automated reconciliation consults the existing SpeakerElection authority before claiming its notice; a temporary deferred election retries through the pending-slot tick. Operator-write replies are not gated. No new adapter send path. Persistence uses the existing atomic state-file writer.

## 6. External surfaces
Users receive fewer false/repeated notes. No new controls or URLs. Backward-compatible optional JSON fields track accepted launch expectations and the last mismatch notice. Claims are written before disclosure, providing at-most-once attempts across server restarts; delivery continues through the existing messaging pipeline. No new operator-facing actions.

## 6b. Operator-surface quality
No dashboard renderer, approval page or form changed; not applicable.

## 7. Multi-machine posture
Machine-local BY DESIGN: the applied launch profile describes a process running on this machine and has always lived in topic-profile-orchestrator.json. Launch expectation and disclosure identity live in that same local process bookkeeping. Automated reconciliation now consults the existing SpeakerElection.decide authority before consuming a notice receipt; no new emission path bypasses it. Topic transfers naturally spawn a new local session whose applied profile is recorded; no pending task is dependent on transferring this local notice receipt. No generated URLs or changed status/health/capability routes. Cross-machine transfer is a new launch, not a second server boot of this process.

## 8. Rollback cost
Revert and ship a patch. Older versions ignore extra state fields. No state migration or manual repair required; reverting restores the old misleading notice behavior.

## Class-Closure Declaration (display-only mirror)
Defect class: unbounded-self-action. Closure: guard. Enforcement: ratchet. Citation: tests/unit/self-action-convergence.test.ts. Controller: topic-profile-reconciliation-notice in src/testing/selfActionRegistry.ts. Repeated boot → same mismatch → disclose was the loop edge. The durable profile fingerprint is the settling brake: at most one mismatch notice while pressure stays unchanged; system busy retries emit no twin. A changed intent or successful recovery starts a different episode. The ratchet uses the production claimReconciliationNotice primitive and reloads durable state on each modeled boot; the HTTP lifecycle additionally exercises the real orchestrator and disk writer across three boots.

## Second-pass review
**Reviewer:** /root/review_notices (independent read of runtime diff, regression tests and this artifact).

**Concur with the review.** Accepted launch expectations remain separate from topic policy, real profile writes invalidate them, and successful application clears the disclosure episode. Durable notice admission bounds repeated boots; the automated-only speaker consult happens before receipt consumption and pending slots retry deferred admission. Existing idle/protection decisions and operator-write replies retain their behavior. Review findings on protection disclosure, explicit per-topic defaults, pin-write invalidation and atomic convergence recording were addressed before concurrence.

## Rebase and failed-shard repair (2026-11-05)
Replayed the original single-commit PR onto origin/main 09e59eb50 in /tmp/instar-pr2802-worktree, hosted by a fresh clone with explicit echo@instar.local identity. Both sides of the self-action registry insertion are retained. The lint regression now copies its script, manifest and template population into a disposable directory rather than writing an undeclared Python file into the source tree. The Linux browser-rule fixture invokes Python with -B so importing the shipped driver creates no source-tree bytecode. Neither repair changes shipped runtime logic or relaxes a guard. The transient Chrome timeout was in the old unit lane, which main has since separated from integration/E2E; complete browser coverage remains in CI. No sessions or test agents are started on this laptop. Rollback remains a code revert; no additional persistent state or external surface is added by these test repairs.

Repair validation: 649 targeted unit and convergence checks passed; the clean-tree source template check remained empty. Full matrix and browser checks run in GitHub Actions. One repair review pass; fresh trace and commit gates run after this artifact is finalized.

Repair second-pass reviewer: /root/review_pr2802 (read-only independent audit). **Concur with the review.** Launch expectations preserve explicit framework/model choices while still detecting unapplied thinking/effort settings and later profile changes. Durable receipts suppress repeated boots; speaker deferral leaves the receipt available for retry. Registry conflict resolution retains all main-branch controllers. Isolated lint fixtures avoid source mutation and Python -B prevents bytecode pollution. No sessions, tests or agents were started by the reviewer.

## CI child-exit toolchain repair
The repaired-head runs exposed two Linux tmux failures beyond the original lint/Python problems. The real session-lifecycle case still timed out with a30-second wait; dead-job-pane-cleanup repeatedly saw pane_dead=1 with no terminal result. Longer waits are not the fix: the lifecycle case's original8-second wait and normal case deadline are restored, with per-case cleanup retained to prevent one failure consuming the next case's capacity.

Ubuntu runners supplied tmux3.4. The observed missing child result matches upstream tmux/tmux#4559, whose fix fa5f3cef explicitly reissues SIGCHLD after libutempter cleanup. CI now builds pinned tmux3.6a, which includes that fix, in a runner-temporary directory; the official release's SHA256 is verified before extraction. Unit, integration and E2E lanes share one bounded installer and expose the same binary through PATH and /usr/local/bin (the application's absolute-path detector checks that first). The installer refuses non-GitHub/non-Linux execution. No product runtime file, production host package, credential, merge criterion or test outcome assertion is changed. Revert the CI script/workflow changes to roll back this tooling repair.

The retained-pane fixture also has a deterministic release barrier: its process cannot exit or close descriptors before remain-on-exit is installed successfully. Clean exits request retention before release too. The pending-result fixture ignores SIGHUP before closing its PTY and requires both exit status and exit signal to remain unknown before testing the running state. Failure diagnostics include the actual pane fields. These changes preserve the real process, exit, rate-limit, cleanup and unknown-result assertions; no exit code is synthesized and no server is signaled by test code.

Evidence: GitHub CI run42112477776 job127543332625 contains the dead-pane failures; job127543332633 records the lifecycle30-second timeout. Upstream issue: https://github.com/tmux/tmux/issues/4559 ; fix: https://github.com/tmux/tmux/commit/fa5f3cef3d651b0eb9abfa77fc37ccade81679b5 ; release: https://github.com/tmux/tmux/releases/tag/3.6a . The new CI wiring contract fails all3 cases on the original workflow and passes with the shared installer;24 CI workflow contract checks pass locally without real sessions. Real-process confirmation remains in GitHub CI, respecting the laptop restriction.

Independent toolchain repair review by /root/review_pr2802: **Concur with the repair.** Official asset digest and inclusion of upstream fa5f3cef in3.6a independently verified. GitHub/Linux-only installer bounds installation and consistently selects the fixed binary in all three lanes. Fixture barrier and HUP handling preserve the intended assertions. No sessions or test agents were started during review. Additional gate attempts reflect failures in the inherited tmux dependency, not new production authority or an expanded feature.

## Random-word assertion repair
Run42126126603 passed integration, E2E and the repaired Node20 retained-pane shard. Node20 shard3's sole failure was an array-only assertion that swapping two randomly generated words always changes the array; both words were `basic`. Remove that assertion, which invokes no production comparison. Keep the actual typo, length and real-word mismatch API checks, and require HTTP200 for the mismatch response. This changes only test reliability; no pairing behavior, runtime authority or persisted state changes. Independent reviewer /root/review_pr2802 concurs that API rejection coverage remains intact and the status assertion strengthens it. Rollback is a test revert.

## Current-main replay (2026-11-06)
All eight unit shards, integration and E2E passed on21b6327f3 (run42146701456; one isolated worker exit passed its single-shard retry). While the dependent Build job waited for a runner, main independently replaced the same lint fixture and introduced a conflict. Replay the approved change in a fresh worktree from origin/main2b1c8c6bb. Keep main's isolated lint fixture, including its additional read-only check against the real source tree. All runtime, controller, CI and lifecycle changes merge cleanly with main; no new product behavior or authority is introduced. Full CI must rerun on the new head before merging. No sessions or test agents run on the laptop.

Independent replay review by /root/review_pr2802: **Concur with the rebased candidate.** Main's two-case lint fixture remains unchanged, and newer controllers including attributionAuditRetry remain registered. Notice logic, spawn wiring, pinned tmux installer and fixture repairs retain their reviewed behavior. No unresolved index conflicts or whitespace errors; no tests, sessions, agents or file mutations during review.

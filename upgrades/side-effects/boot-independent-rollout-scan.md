# Side-Effects Review — Responsive Feature-Release Discovery

**Version / slug:** boot-independent-rollout-scan
**Date:** 2026-11-22
**Author:** echo
**Second-pass reviewer:** independent security/artifact reviewer /root/n78_security_r1

## Summary of the change

The server now injects an asynchronous local/canonical scanner into FeatureRolloutReconciler. File operations use asynchronous reads; Git uses the existing SafeGitExecutor spawn/readStream authority. The reconciler owns one full flight, yields between artifacts, and stops discovery and future writes before dependencies close. Startup launches discovery only after the existing signal and restart shutdown owners are installed. No lease, role-restart or production configuration change is part of this source change.

## Decision-point inventory

- Discovery routing — modified: server awaits async safe operations, preserving isolated synchronous callers.
- Canonical snapshot — modified: Chief566c3db1-authorized leading plus on the exact main-to-remote-tracking refspec and immutable commit pin avoid shared FETCH_HEAD substitution; current published main, including rewind, remains the observation target.
- Complete discovery — modified: a failed listed blob discards the entire canonical attempt; complete async local fallback is diagnosed. Cancellation never falls back.
- Concurrent execution — added invariant: one discovery/application promise at a time, no queued retry.
- Shutdown — modified: mark stopped and abort synchronously; arm the existing deadline before awaiting cleanup; no new tracker write begins afterward.
- Lease and restart — pass-through: current expiry, signatures, epochs, renewal, demotion and restart decisions unchanged.

## 1. Over-block

There is no new user-message or tool-permission blocker. Git retains its actual existing ten-MiB per-stream buffer and existing thirty-second/default configured fetch deadline. An unavailable canonical blob now produces complete local fallback rather than silently applying a partial canonical inventory. Missing optional directories remain empty; a listed but unreadable local file rejects discovery. This may expose prior partial-read problems as failed observations; it cannot reject an owner message or claim fresh canonical evidence from partial data.

## 2. Under-block

Other synchronous server paths may still cause stalls. This repair does not establish that every millisecond of the incident came from this scan. A successful local fallback does not prove canonical reporting freshness; it is explicitly diagnosed. The broader demotion-service fencing and restart-loop repair is N81, explicitly separated by Chief70019126. Hard process death retains existing supervisor cleanup limitations; no long-lived scanner child is introduced.

## 3. Level-of-abstraction fit

This is an I/O scheduling repair at the existing observation adapter and reconciler lifecycle. It uses the safe Git executor rather than adding a parallel destructive-operation path or another lease writer. Complete observations still feed the existing InitiativeTracker authority and version checks. The scanner does not decide who owns a machine or which owner action to permit.

## 4. Signal vs authority compliance

Reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

- [x] No — this change produces a signal consumed by an existing authority.

Release inventory is observation evidence. Success/failure/cancellation reflect finite command outcomes, not a heuristic applied to user intent. The lease coordinator and current restart policy retain their authority. No regex-based permission gate or model judgment replacement is introduced.

## 4b. Judgment-point check

No new competing-signals heuristic or numerical permission floor. Buffer and deadline values preserve the actual executor defaults. Earlier review text mistakenly cited a generic one-MiB default; implementation source inspection corrected the adapter and spec to the actual ten-MiB default, with that correction recorded honestly in the review report. Existing six-hour cadence and configured fetch deadline remain. A single flight and terminal stop are explicit ownership states, not confidence thresholds.

## 5. Interactions

Git source-tree checks, environment scrubbing and audit remain in SafeGitExecutor. The existing canonicalRefScan flag still selects canonical versus local observations. Both paths are asynchronous in server wiring. Parent cancellation terminates the owned fetch group on Unix or the direct child on Windows and awaits closure; read commands retain executor timeout behavior. Application yields one event-loop turn per artifact. Shutdown clears cadence, stops discovery before storage teardown, and uses the existing hard deadline. Initial discovery begins only after shutdown ownership exists, preventing a failed earlier boot from starting this scan. Existing role handling and scheduling remain unchanged.

## 6. External surfaces

No new HTTP endpoint or dashboard control. Existing health and release-state routes should remain responsive while discovery runs. New awareness text explains the operational distinction between configured behavior, local test evidence and installed proof. User-facing release prose names availability and leadership in ordinary words. No new owner notification or automatic outbound message is added.

## 6b. Operator-surface quality

No operator surface — not applicable. There is no new form, button, consent flow or raw identifier shown as primary content. The release fragment and overview describe the user benefit and staged verification honestly.

## 7. Multi-machine posture

**machine-local** — each running server discovers its own view asynchronously using existing configured canonical remote and local paths. This changes no replicated format, epoch, signer or lead election. A machine applies complete evidence from its pinned canonical snapshot or complete diagnosed local fallback. The stopgap on Studio is owned separately by the verification coordinator and is not represented as this repair being deployed.

**Status surfaces:** no new or changed status schema. Existing health and feature-release views remain; canonical fallback is diagnosed and cannot be represented as canonical freshness. Temporary test health/lease endpoints exist only inside isolated fixtures.

## 8. Rollback cost

Revert the source change through the normal reviewed release pipeline. No state migration, schema mutation, lease transfer, credential rotation or production restart is needed to prepare that revert. Reverting restores synchronous scan risk, so deployment owners must account for the separately staged stopgap. No claim that a rollback is already executed or risk-free is made.

## Conclusion

Independent source/side-effects review concurred, including the bounded refspec correction. The corrected allocated targets passed13unit,2HTTP and16lifecycle tests, all exit0, on manifestf66692d0. The single supported no-roundtrip startup check returned PASS/CLI0 with independently verified absence of its exact process, listener and guarded home after cleanup. These are local targeted and startup results, not complete final-head verification, merge or production deployment. Requirements include canonical stale-ref/rewind and competing-fetch correctness; separate canonical-only success and local-only failure; real full-duration health/lease evidence on canonical and local paths; cancellation, finite cleanup and initialized HTTP lifecycle.

## Second-pass review

**Reviewer:** /root/n78_security_r1
**Independent read of the artifact:** Concur. Complete source and new tests reviewed; no required fixes before allocated verification. Actual ten-MiB buffer, terminal cancellation, finite command closure, one full flight, external health and real isolated lease probes verified in code. No tests or deployment performed by reviewer. The corrected actual test executions are recorded below, separately from that review.

## Evidence pointers

- Spec and plain overview: docs/specs/boot-independent-rollout-scan.md and matching .eli16.md.
- Review report: docs/specs/reports/boot-independent-rollout-scan-convergence.md. This records the six-round cap and operator-authorized bounded closure, not full convergence.
- Chief scope70019126 and bounded closure8bd0d9d5; exact closure candidate SHA bb8991be7a8be1f7a71aecf14bb0e2ba7349d5dd72565c400d7a68e8b384eaf0.
- Corrected source build and normal lint exited zero. Private Node24.14.1 ABI137 actual SQLite probe returned1. All11 source/test hashes still match tested manifestf66692d0 after documentation-only evidence updates.
- Actual one-batch result: /tmp/n79-corrected-result.json, completed23:25:39.214878Z; admissions15151/19778/86725. Startup receipt: /tmp/n79-startup-command-result.json, exit0 at23:27:51.841804Z; teardown /tmp/n79-startup-teardown-proof.json. Durable private evidence .instar/recovery/n79/corrected-targets and startup. No further manual suite or startup check is allocated.

## Class-Closure Declaration

Defect class: unbounded-self-action. The existing periodic scanner owns a single finite reconciliation flight and each Git command retains its existing finite deadline. Cancellation is terminal and shutdown stops new actions. Actual class declaration and source evidence must be recorded in the normal trace after tests; this prose is not a substitute for the machine-readable closure. No claim of a fleet-wide guarantee from a local configuration or compile is made.

## Captured Rewind Failure and Authorized Correction

Original allocated unit run:40passed/1failed, actual admission50843, exit1; HTTP and lifecycle did not run. Diagnostic-only allocated unit file:12passed/1failed, admission12802, exit1. Actual stderr reported a non-fast-forward rejection on the second canonical fetch. Chief566c3db1 selected the leading plus only on refs/heads/main:refs/remotes/<canonicalRemote>/main, with no --force flag or local branch/worktree destination. The real rewind test now asserts the exact two command arrays and unchanged consumer HEAD and worktree status. The required bounded boundary review returned CLEAN, and prior concurrence remains valid. At that review point corrected execution was pending; the final local verification section below records the later actual results.

## Final Local Verification Scope

The original cohort remains40passed/1failed, and the diagnostic remains12passed/1failed. They are preserved rather than relabeled. Corrected source targets:13unit,2HTTP,16lifecycle passed with actual enforced admission and zero exits. The four unchanged unit files retain their original28passing cases as qualified earlier-byte evidence, not a new final-head suite. Full normal verification of the eventual exact GitHub head remains with the verification coordinator.

The startup report has six steps and did not itself prove teardown. The command actually exited0; independent exact target PID and listener checks were empty, its retained inspection home was removed through SafeFsExecutor under allocation8a3abea9, and a separate standalone probe confirmed its absence. A combined post-cleanup probe initially matched its own surrounding handoff shell text; the dedicated standalone probe corrected that measurement and its receipt records the distinction. Throughputf18d9480 independently accepted the actual cleanup evidence.

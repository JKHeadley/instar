# Side-Effects Review — Security Review Evidence Preflight

**Version / slug:** security-review-preflight
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** review_connector_reads, independent read-only source review

## Summary of the change

Tier1 reversible default-off diagnostic. Adds SecurityReviewPreflight, detached JobScheduler wiring, awareness/state declarations, tests and documentation. It writes complete private declared-input packets after the normal session/run exists; it never changes prompt, model/account routing, reads, review admission or completion. A revert restores prior behavior with inert derived files. This is a SMALL build with one independent review plus correction of an actual validator finding; normal commit gates and complete throughput verification still apply. Size is recorded in the commit trace; there is no formal spec-convergence claim or live activation.

## Decision-point inventory

- Literal enabled flag and explicit sourceRoot — add, diagnostics only; absence/invalid config preserves normal review.
- Stable bounded input/coverage checks — add, determine whether evidence is available, never whether an agent may review or read.
- Private output permissions, role/flag narrowing and retention — add, restrict only diagnostic writes.
- Existing model spawn, original prompt, reads, security semantics and completion — pass through without a new await or session.

## 1. Over-block

No security review, source read or agent action is blocked. Missing/changing inputs, unsupported rotation values, oversize sources, wrong permissions and unavailable storage decline a packet while the normal session proceeds. Output privacy intentionally refuses a permissive/symlink private directory. Full source text is retained, including duplicate Markdown headings, old findings and mixed statuses; there is no regex active-only summary.

## 2. Under-block

A complete packet proves only coverage of its four declared inputs during a checked snapshot window. It does not prove actual delivery, retained context, code-tree coverage, model availability, semantic judgment, successful review or upstream completeness. All those unknowns remain explicit. Sources may change after the snapshot, and the model may update rotation during detached capture; that is not permission to skip anything. Trusted local filesystem/config access remains the trust boundary; this is not a defense against an actor able to rewrite all agent state.

## 3. Level-of-abstraction fit

The scheduler knows the actual dispatched prompt, run and returned session. It is therefore the right producer of run-bound evidence. The private ledger remains the finding authority and the model remains the review authority. This module neither interprets statuses nor supplies read-suppression instructions. It uses existing SafeFsExecutor for exact owned derived-file retention and the existing awareness registry update path.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. This is a signal producer without blocking authority. It cannot skip a model session, advance a rotation/bookmark, suppress a source read, certify a finding or route a model. Its status is scalar optional telemetry; diagnostics fail independently of the launched job.

## 5. Cascade / interaction analysis

Ordering: capture starts only after normal spawn and run binding/bookkeeping. Its Promise is detached and both rejection and telemetry errors are contained. Slow IO cannot hold ordinary trigger/completion or add a session. One capture is in flight per scheduler instance. Snapshot checks cover ordinary file identity and stability across all reads; symlink inputs/output are refused. Flags and write authority are rechecked before publication. No timer, retry, re-drive, notification or new model helper is introduced. The module snapshots caller binding/config values so outside alias mutation cannot change a capture in progress.

Source reads use bounded asynchronous file handles. Limits are4MiB per input,8MiB raw total,16KiB chunks and128 output-directory entries. Complete owned UUIDv4 packets are retained to16; unknown files and incomplete crash artifacts are never treated as evidence. Enumeration overflow makes diagnostics unavailable. The export verifier now rejects malformed/null sources/chunks, excessive chunk counts, non-final short chunks, gaps, duplicates, noncanonical base64 and hash mismatches before unbounded buffer allocation.

## 6. External surfaces

No subprocess, external API, model call, public route or operator action is added. No live config/job/schedule is edited. Packet content is private: existing private parent must be0700, own directory0700, packet/temp0600; output is atomic and exact failed temp cleanup is attempted. Events contain only status, fixed reason, run and packet ids, never text, source paths or raw errors. Private source ledger, map and rotation are never written by this feature.

New and existing agents receive awareness through the existing awareness registry/update pipeline. The new flag is absent/off without any activating migration. No installed hook/script or default config change requires a dedicated migration.

## 6b. Operator-surface quality

No operator-facing action or UI surface is added. There is no new approval/configuration form or read-suppression control.

## 7. Multi-machine posture

Machine-local by design: the packet names an actual local launched run and snapshots local source inputs. It is not replicated and does not grant another machine coverage or read-suppression authority. Failover continues normal security review with the feature off unless explicitly configured locally. No one-voice outbound channel or transferable user-facing URL is introduced.

## 8. Rollback cost

Disable the flag or revert the code. Existing derived packets are inert; no data repair, source rewrite or external rollback is necessary. Retention only removes owned Class-B diagnostic copies, never the sole findings ledger or any unknown artifact.

## Conclusion

The approved evidence-only stage is complete behind a default-off flag. Review found a malformed-chunk validator gap, which now has structural bounds and regression tests. Two initial test-harness assumptions were corrected: macOS canonical temporary paths and waiting for normal asynchronous spawn bookkeeping. These were not presented as production defects. Focused tests and normal lint/commit gates establish the targeted behavior; complete-suite results must come from throughput. No live installation, read suppression or realized savings is claimed.

## Second-pass review (if required)

Reviewer: review_connector_reads. Initial review found missing malformed-chunk/count checks. The reviewer re-read the corrected source, spec, ELI16 and artifact and concurred, with no remaining blocking findings. The reviewer ran no tests and inspected no live ledger.

## Evidence pointers

New unit tests: security-review-preflight.test.ts and security-preflight-scheduler.test.ts. HTTP: security-preflight-routes.test.ts. Lifecycle: security-preflight-alive.test.ts. Worktree .instar/state/build contains unit-commit.log, integration-final.log, lifecycle-final.log and lint/commit logs. Full test:all goes through throughput.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is being repaired. This is one diagnostic call attached to an already-authorized normal spawn, with no self-triggered loop, retry, recovery, re-drive or additional spawn. For the detector's scheduler notification/spawn vocabulary, declare defectClass unbounded-self-action, closure n/a, reason: the existing scheduler remains the only controller; the new code only captures one bounded evidence packet per normal launch and cannot trigger another action. There is no convergence claim for a nonexistent new controller.

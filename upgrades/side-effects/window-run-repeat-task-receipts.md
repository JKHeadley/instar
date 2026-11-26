# Side-Effects Review — repeated W32 receipts for an open task

**Version / slug:** `window-run-repeat-task-receipts`  
**Date:** `2026-10-30`  
**Author:** `echo`  
**Declared tier:** 1 — narrow, reversible selector correction; a revert restores the previous behavior.  
**Second-pass reviewer:** independent read-only review completed; concurred after the non-adjacent replay guard was added.

## Summary of the change

`AgentServer` reads the canonical run checklist and prior work-receipt audit. It first selects the earliest open task with no receipt. After every open task has one, it selects the earliest still-open task. The same selector feeds `POST /window-run-liveness/work-advance`, recovery, and cadence checkpoints. `WindowRunLivenessAuthority` rejects any artifact digest previously receipted in the run, alongside its existing run binding, active state, executor, and deadline checks. This is two source files and four test files, plus version and release artifacts; one commit-gate attempt has failed while the required trace was missing.

## Decision-point inventory

- Task selection — modified deterministic selection inside the existing server authority. It reads only the authenticated run's checklist and audit, and never trusts client-supplied task refs.
- Artifact and run validation — extended digest replay validation from the latest receipt to the complete receipt audit. The authority still blocks unchanged bytes, wrong-run frontmatter, no open task, wrong executor, and expired runs.
- Recovery and cadence — existing consumers of the same selector now receive a still-open task after all open tasks have prior receipts.

## 1. Over-block

A legitimate changed artifact on a still-open task is no longer blocked solely because that task had an earlier receipt. Completed tasks remain ineligible. If the checklist has no open tasks, selection returns null and the route returns 409. The binding guards remain unchanged; the digest guard now also rejects a non-adjacent replay.

## 2. Under-block

A malicious client could ask for repeated receipts, but it cannot select the task or supply digest, sequence, or timestamp. The server hashes the file under the registered run root and rejects any digest already in this run’s receipt audit, including A/B/A replay. This does not prove the *quality* of work in the file; that was already outside W32's mechanical liveness contract. No new exception to run expiry or delivery/heartbeat requirements is added.

## 3. Level-of-abstraction fit

The selector belongs in `AgentServer`, where the canonical local checklist, run ID, and audit are available. The route must not accept a client task ref. The low-level liveness authority continues to check receipt freshness and monotonicity; cadence continues to evaluate each due interval. A fallback in the client prompt would be unenforceable.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md` exempts hard structural invariants from context-sensitive judgment. This selector is a deterministic invariant over a verified checklist and receipt history, not a regex judgment about message meaning. It does not gain independent blocking authority; the existing W32 authority still decides whether a receipt is admitted. The previous false block arose from using an unreceipted-task lookup as a permanent limit on long tasks.

## 4b. Judgment-point check

No new judgment point. The selector does not infer user intent or determine whether a task is useful; it only identifies an explicitly open checklist task. Qualitative review and merge approvals remain separate.

## 5. Interactions

The existing audit records every receipt with a sequence and digest. Repeated task refs are allowed; sequences and changed digests remain distinct. A task marked completed is skipped on the next request. The initial preference for an unreceipted task preserves W32's adversarial recovery behavior whenever such a task exists. The 30-minute cadence can consume a later changed receipt from the same task in a later interval. The fix does not alter existing receipts, timing, or the checklist parser.

## 6. External surfaces

An authenticated work-advance request that previously returned 409 after all open tasks had one receipt can now return 201 if the artifact contents have not appeared in any prior receipt. Recovery may resume the earliest open task in that case. No new endpoint, response field, user-facing notice, or URL is introduced. The active run can remain healthy for its registered 24-hour ceiling while it produces real changed artifacts; it cannot extend that ceiling.

## 6b. Operator-surface quality

No operator surface is changed; not applicable.

## 7. Multi-machine posture

Machine-local by design: W32 is an Echo development-agent authority bound to one active executor and that machine's canonical run file. The code change ships uniformly, but a receipt is minted only by the current owner with its local audit. It emits no new notice, holds no new durable state, and generates no URL. Existing owner/transfer checks still govern which machine can act.

## 8. Rollback cost

Revert this selector change and version/release artifacts. Existing repeated receipts remain valid historical audit entries; the older selector would refuse the next one once all open tasks had a receipt, potentially making a long run at risk. No schema migration or destructive cleanup is involved.

## Conclusion

The change corrects a demonstrated long-run liveness defect with a narrow fallback. Unit, integration, E2E, full-suite, and CI results are pending; no gate is claimed passed here. The current Echo run may need additional *real* checklist work until this fix is merged and deployed. It will not rewrite prior audit records.

## Second-pass review

The independent reviewer first found that latest-only digest validation would admit an A/B/A/B content replay once repeated task refs were allowed. I extended the authority's check to the full durable receipt audit and added unit, HTTP integration, and production E2E cases. On re-review the reviewer found no remaining code blocker and concurred, subject to correcting the file count, validation description, and staged artifact; those corrections are in this version. Test execution and the final commit gate remain pending.

## Evidence pointers

- Current-run receipt sequence 5 occurred on 2026-10-30 15:01 UTC while all five original tasks remained open; a sixth request against the original five-task ledger would have had no unreceipted task under the deployed selector.
- Isolated worktree: `.worktrees/window-run-repeat-task-receipts`.
- Unit: `tests/unit/window-run-task-selection.test.ts` and `tests/unit/window-run-liveness-authority.test.ts`.
- HTTP integration: `tests/integration/window-run-liveness-routes.test.ts`.
- Production lifecycle: `tests/e2e/window-run-liveness-production-wiring.test.ts`.

## Class-Closure Declaration

`unbounded-self-action`: n/a. This change adds no loop, timer, or self-trigger. A receipt still requires an explicit request, a currently open run, a changed artifact, and the existing authority predicates.

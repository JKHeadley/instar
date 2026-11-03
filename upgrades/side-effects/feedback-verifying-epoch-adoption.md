# Side Effects Review — adopt intact verification after owner epoch change

**Version / slug:** `feedback-verifying-epoch-adoption`  
**Date:** 2026-11-02  
**Author:** Echo  
**Spec:** `docs/specs/feedback-triage-and-execution.md` §4  
**Second pass:** independent read-only reviewer concurred after the crash-gap correction

## Incident and change

The live critical SecretStore feedback attempt `feedback-e800bf35-6381-46e7-a769-1530c55ac7ac:a3` reached `verifying` under owner epoch 23318. A same-machine lease reacquisition advanced the owner to 23319. The next executor tick stopped the attempt as `stale-epoch` at 2026-11-03T05:45:36Z, before review or PR creation, and cleaned its workspaces. The prior `running` state had a same-machine adoption path, but `verifying` did not.

The correction admits a same-machine verifying row with either its original workspace or the renamed review directory and its publish clone still present through the owner-change stop check. It adopts that row under the new epoch and runs the existing one-time re-verification path. A missing clone, missing worker/review tree, or different machine still fails closed. No old owner write is accepted by the epoch fence.

## Decision points and side effects

- **Stop/adopt:** `runStopPaths` now treats an intact same-machine verifying row as adoptable, including after the normal workspace-to-review-directory rename. It does not stop the session or clean its workspaces solely because the epoch changed.
- **Reconcile:** `reconcileLive` adopts that row under the current epoch before using the existing `reverify-after-restart` state transition. The next tick repeats the trusted checks before any PR publication.
- **Ambiguous publication:** Before an external push, the executor records `reason: publishing`. If an owner change or restart interrupts publication, it holds the execution row as `publish-outcome-unknown`, preserves the clones, and raises an attention item to reconcile the fork branch and PR. It does not replay the push or create another PR. A triage item still in `work` is held with the existing decision-sequence CAS; an operator's newer hold or ignore decision is left untouched. This also covers an external publication error whose side effect is uncertain.
- **Crash repair:** A held publication with unknown outcome is excluded from candidates even if a crash left triage in `work`. Every tick retries the conditional triage hold and raises the same stable attention ID. An uncertain branch or PR requires manual reconciliation before further work on that item.
- **Safety:** The clone requirement prevents adopting a partial verification. The single-flight executor tick and owner-fenced writes remain in place. Remote-machine attempts still stop, except an already-started publication is held for reconciliation; no extra attempt or daily start is claimed by adoption. An old owner can still complete an external call already in flight, but its database write is fenced and the new owner does not duplicate that call.
- **Rollback:** Reverting this patch restores the old stop behavior. No schema, config, installed-file, or migration change is needed.

## Verification

The regression simulates a same-machine owner change after the normal review-directory rename, then checks adoption, one re-verification, and one PR-open attempt. A missing publish clone is still stopped as stale. A `publishing` marker under either the same or a new epoch is held without an additional attempt or repeated external call. An intervening operator hold/ignore stays intact. A crash between the execution-row hold and triage hold blocks candidates and repairs the hold and alert on the next tick. A lost PR-create response after the fake GitHub gateway accepted the PR produces one held attempt and exactly one PR. Focused executor tests: 97/97 passed; build passed. Full unit on the corrected tree: 55,837 passed, 15 skipped, zero failed. Full-server execute-route integration: 9/9 passed. Production lifecycle E2E: 2/2 passed. The initially malformed release fragment was corrected with its required section heading and its focused 232-test suite passed. Three accurate component rows raised the docs coverage class score to its 55% floor; `docs-coverage --check` passed. Full integration, full E2E, CI, and live proof are pending.

## Second-pass review

**Reviewer:** `/root/feedback_gate_review` (independent read-only reviewer)

The reviewer found the crash gap in the initial diff. After the candidate block and repair scan were added, the reviewer concurred and reported no remaining correctness blocker. The reviewer noted that an old owner can finish an already-started external action, so an unknown publication remains held for human reconciliation.

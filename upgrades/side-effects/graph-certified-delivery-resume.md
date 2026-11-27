# Side-Effects Review — Conversations: a certified change with unfinished delivery is finished, not left pending

**Version / slug:** `graph-certified-delivery-resume`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (replication commit path); response appended below`

## Summary of the change
Justin (topic 141385, 2026-11-16 16:24 PST) tapped "Accept all 21 projects"; the first project's `set-primary-placement` stayed `saved-pending` and the Accept never finished. Read from the Studio's stored graph state (look-only): the change was captured 00:23:22Z, certified 00:23:37Z, certificate receipts from both members (Studio 00:23:37.9, M5 Pro 00:23:42.6), and no commit-proof delivery receipts at all. Twelve more records were parked at the same point (sequences 263…353). The acknowledged-snapshot check stops at the first such record, which is the repeating `graph-local-snapshot-reader-mismatch` / `graph-local-acknowledged-snapshot-unavailable` warning.

Cause: `ConversationGraphReplicationRuntime.reconcilePending` (the 15 s pass on the lease holder) selected only records with no certificate. `ConversationGraphCommitCoordinator.commit` returns `saved-pending` when a member is slow at the certificate or commit-proof step; after that nothing called it again for that record. The owner status GET is read-only.

Fix (2 source files, about 25 LOC changed plus one extracted method):
- `ConversationGraphCommitCoordinator`: the tail of `commit()` (member certificate persistence → commit-proof delivery → delivery completion → final admission recheck) is extracted unchanged into `deliver()`. A new branch, placed after the existing packet/signature/actuator checks, sends a known record that already has a certificate (state `certified` or `committed`, not cancelled, not imported history, not erased) straight to `deliver()`. Members whose certificate receipt is already recorded are not asked for it again.
- `ConversationGraphReplicationRuntime.reconcilePending`: also selects certified records whose delivery completion is not persisted (not cancelled, not erased, not imported history). A per-process set remembers finished deliveries so each record's receipts are verified once, not every 15 s.
- Test: `tests/integration/conversation-graph-replication-runtime.test.ts`, real two-machine runtime: the commit-proof call is dropped → `saved-pending`; a pass while the member is silent keeps it pending; once it answers the next pass returns `committed` with no second `prepare`/`commit` at the witness; later passes skip it.

Tier: declared 1 (narrow bug fix; revert restores the old behaviour and every delivery made meanwhile remains a valid, verified receipt). Effort: 1 commit attempt, no spec rounds.

## Decision-point inventory
- `reconcilePending` record selection: which records the writer resumes. Widened to certified-undelivered.
- `commit()` resume branch: skips prepare/certify for a record that already holds a certificate.
No new authority: every receipt is still verified by the same source checks, and each member still decides whether it accepts a certificate or proof.

## 1. Over-block
None identified. The new branch only applies to records that already hold a certificate.

## 2. Under-block
- A record whose writer is another machine (actuator check fails) is still not finished from here; unchanged from before.
- A certified record with an erasure is deliberately left out (the erasure flow owns it).
- If a member permanently refuses the proof, the record is retried every 15 s and stays pending; the status body still does not name the delivery-stage reason (`waitingMachines` lists certificate receipts only).

## 3. Level-of-abstraction fit
The coordinator already owns the commit sequence and the runtime already owns the retry pass; the fix widens the existing pass and reuses the existing delivery code. No parallel mechanism.

## 4. Signal vs authority compliance
No brittle check gains blocking authority. The final `mayAcknowledgeNewWrite` recheck still gates the returned outcome; durable state decides what the status GET reports.

## 5. Interactions
- Before this change a client re-POST of a certified request re-ran `mayContinue`, `receive`, `witness.prepare`, member `receiveSource` and `witness.commit` (all idempotent) before delivery. It now goes straight to delivery. A certified record under an older lease epoch, which the old path refused at `mayContinue` (`recovery-required`), is now delivered: consistent with the existing branch that publishes delivery completion for a committed record with no lease check ("a writer transfer cannot undo a locally verified final certificate").
- Cost, bounded: a resumed delivery rewrites the certificate file, makes one witness acknowledgement per member and the member calls (5 s peer timeout each), inside the serialized mutation queue. To keep a silent member from costing that once per parked record, a pass stops resuming deliveries after the first one that does not finish, and a record that keeps failing is retried with a doubling gap (1, 2, 4 … up to 40 passes, about 10 minutes). A record that can never complete (certified by another writer, or under a membership that includes a since-removed machine) therefore settles at one attempt per 10 minutes.
- A member whose certificate receipt is already stored is not called again, but the stored receipt is still sent to the witness (idempotent), covering an earlier attempt that stored the receipt and then failed at the witness.
- The pass is still gated on holding the lease and on readiness.

## 6. External surfaces / 6b. Operator surface
Peers receive `certificate` (only when their receipt is missing), `proof` and `completion` calls for older records, all existing actions. The owner sees pending changes complete; no new wording.

## 7. Multi-machine posture
Replicated by design: this is the replication path itself. Only the lease holder runs the pass; members verify what they are sent. A mixed-version fleet is safe: no new action or field.

## 8. Rollback cost
Revert the commit. Deliveries completed meanwhile are valid and stay; records not yet delivered return to permanently pending.

## Evidence
`npx vitest run --config vitest.integration.config.ts` on conversation-graph-replication-runtime, conversation-graph-witness-review, graph-default-peers, graph-default-nonmember-paired: 40 passed; unit conversation-graph-replication*, 82 passed. Live check after deploy: the Studio's pending list (`GET /conversation-graph/pending`) no longer holds request 899b192f…, and the thirteen parked records gain delivery receipts.

## Second-pass review
Independent reviewer subagent, 2026-11-16: "Concur with the review". No blocker. Three should-fix points, all taken before commit: (1) a skipped member's stored certificate receipt is still acknowledged at the witness; (2) per-pass cost understated — resumed deliveries now stop after the first that does not finish and back off per record; (3) the review now states the settled cost for records that can never complete. Reviewer verified the resume branch cannot be reached for quarantined, cancelled, imported or other-writer records, that every repeated step is idempotent, and that members accept proofs bound to the record's own lease epoch.

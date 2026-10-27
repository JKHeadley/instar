# Side-Effects Review — Correction capture and review capacity

**Version / slug:** `agent-improvement-capture-capacity`  
**Date:** 2026-10-27  
**Author:** Echo  
**Second-pass reviewer:** Independent `review_capture_capacity` agent

## Summary of the change

The correction capture loop now puts a detected user correction into the existing bounded, scrubbed backlog when expensive model work is shed. The class-review engine now counts linked open Initiatives and Actions, rather than all review receipts, against its work-artifact cap; it also respects the remaining slots when one review proposes both kinds of work. The change touches capture and class-review decisions, but creates no new authority to alter standards, send feedback, or block a user message. The isolated branch is based on `origin/main` at `337a89a06` (v1.3.1470) in `.worktrees/agent-improvement-pipeline`; `origin` is `JKHeadley/instar`.

## Decision-point inventory

- `captureAndDistill` load-shed branch — modified: queue a scrubbed signal instead of discarding it when a backlog exists.
- `CorrectionClassReview.fill` artifact admission — modified: compare actual open work artifacts with the configured cap, and consume slots per created artifact.
- `server.ts` backlog maintenance — modified: prune on a five-minute timer even when the LLM circuit is open.
- `AgentServer` class-review wiring — modified: route capacity holds to a coalesced Attention item.
- The model's correction classification and class-review judgment — passed through unchanged.

## 1. Over-block

No user message or agent response is blocked by this change. At the work-item cap, a review that asks for both a standards Initiative and a process Action can still hold the second item; the review remains visible. That is an existing capacity brake, now applied per artifact.

## 2. Under-block

A missing or failed backlog still causes a load-shed correction to be dropped; the audit records `shed`. The queue is bounded by count and age, so a long outage can evict old entries. Filled reviews held by the work-artifact cap do not yet get an automatic retry when capacity opens; the linked development topic `131643` and local improvement proposal track that remaining pipeline work. `AgentServer` now routes a cap hold to a coalesced Attention item. Concurrent reviews can still race between counting slots and attaching artifacts; this repair does not claim a transaction across external Initiative and Action writers.

## 3. Level-of-abstraction fit

The capture change uses the existing backlog and drain, which already enforce scrubbing, bounded storage, and later model distillation. It does not add a second classifier. The cap change belongs in the class-review store because the store holds the authoritative artifact links and outcomes. It does not alter the model's meaning judgment.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

- [x] No — this change has no new block/allow surface for messages or actions.

The load-shed branch preserves a signal for the existing intelligence-backed review. The artifact cap is a numeric resource invariant on self-created work, not a judgment of user intent. It remains in the established class-review authority path.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals judgment point. A model still judges the correction's meaning. The only numeric rule changed is counting the resources the existing cap already controls.

## 5. Interactions

- **Shadowing:** `no-signal` still returns before load shedding; only Layer-0-detected user signals can enter the backlog. The rate ceiling remains after load shedding; a shed signal is stored without consuming a model-call rate slot.
- **Double-fire:** Backlog insertion deduplicates nearly identical scrubbed windows. Its drain deletes a row after ledger recording, and the ledger deduplicates by learning key.
- **Races:** Multiple class reviews can still test the cap concurrently before attaching artifacts. This limitation is named above and requires a transactional or reserved-capacity design before the cap can be called strict under concurrent fills.
- **Feedback loops:** Backlog drain calls the same `onRecorded` class-review seam as live capture. It cannot turn an agent reply into a user correction because the capture contract requires `fromUser`.

## 6. External surfaces

The correction ledger can now receive a record that would previously have been lost during load shedding. The backlog SQLite file may hold more scrubbed rows for its configured TTL plus at most one five-minute maintenance interval while the server is running. Class reviews can now create work even when there are many review receipts but few actual work artifacts. A capacity hold creates a coalesced Telegram Attention item through the existing adapter. No GitHub or feedback API call is added.

## 6b. Operator-surface quality

No dashboard, approval page, or operator form changes.

## 7. Multi-machine posture

The capture backlog is machine-local by design: it buffers a message on the machine that observed it and drains into that machine's ledger. Class-review records already use the existing replication emitter and merged reads; this change uses the local store's authoritative artifact IDs for capacity accounting. A capacity hold emits a coalesced Attention notice; it generates no URL. Topic transfer before a backlog row drains remains a broader existing transport-lifecycle concern; this patch does not claim cross-machine capture replay.

## 8. Rollback cost

Revert the code and ship a patch. No schema migration is introduced. Existing scrubbed backlog rows remain readable by the old drain. The old behavior would again drop busy-time corrections and count review receipts against the cap until the rollback is replaced.

## Conclusion

The review found that the cap must count artifacts and must consume slots individually when one judgment proposes two. The implementation reflects both. The identified retry and concurrency gaps are recorded in the development workstream; this repair is a reversible first increment and should ship only after the required test gates pass.

## Second-pass review

The independent reviewer found two initial code concerns: a partially admitted review needed a capacity notice, and backlog expiration needed to run while the model circuit was open. Both were addressed. The second pass found no further code blocker and requested direct test assertions for the new alert and expiration behavior; these are now added. The remaining concurrent-cap race and lack of automatic retry are named limitations, not claims of this increment.

## Evidence pointers

- Live capture audit: topic `130715`, 2026-10-27T20:33:21Z, `decision=shed`.
- Live class-review state: 108 open receipts and one linked open artifact at 2026-10-27T21:40Z.
- Unit, integration, and E2E test files changed in this branch; targeted unit and TypeScript checks passed. Broader checks are queued behind the shared merge test slot.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` closes through the existing `correction-class-review-outcomes` controller registration in `src/testing/selfActionRegistry.ts` and its `tests/unit/self-action-convergence.test.ts` ratchet: the artifact cap remains 50 by default, with one outcome per semantic class. The capacity notice uses one stable Telegram Attention ID, so repeated cap holds coalesce instead of sending unbounded messages. The capture-loop steady-state bound remains the backlog count/TTL and per-tick drain cap. Direct tests cover load shedding, cap accounting, and cap-held attention in `tests/unit/correction-learning-wiring-integrity.test.ts` and `tests/unit/correction-class-review.test.ts`; HTTP and production-path coverage is in the corresponding integration and E2E tests.

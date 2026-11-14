# Side-effects review — held inbound: the fold hold on the Durable Inbound Message Queue

**Version / slug:** `cb-fold-inbound-hold`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.3 "Held inbound" ("Rows live in the Durable Inbound Message Queue with a `hold: fold` reason and the `foldId`; a held row's `entryTtlMs` clock is frozen while its fold record is non-terminal, and the drain refuses to release a row whose fold record is non-terminal (the record, not sweep ordering, is the gate). The per-reason maximum hold is the configured maximum lock TTL ceiling plus the reconciliation bound, exempted from the `holdMaxMs < entryTtlMs` validator by reason. If the queue is dark at a later boot and gate-expires a fold-held row, the fold record moves to `rolled-back` on the same tick and the loss notice names the fold."), §9.3 carriers paragraph, §9.3 step 1 precondition `no-hold-queue`. Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 8, part b; stacked on 8a and 8c.
**Tier:** 2 (schema change to a durable queue on every agent; new custody rule). Size: ~8 files, ~640 LOC incl. ~420 test LOC.

## Summary of the change

1. **`src/core/PendingInboundStore.ts`** — extends the queue's existing freeze machinery (no parallel mechanism):
   - additive columns on `entries` (`fold_id`, `fold_since`, `fold_frozen_ms`), added once on open by a guarded `ALTER TABLE` (idempotent; tested against a pre-change database), and a `fold_holds(session_key, fold_id, since)` table: the session-level hold, because a fold usually begins with nothing queued and a row-level mark alone would miss the next arrival;
   - `holdForFold(sessionKey, foldId)` writes the session hold and freezes that session's queued rows; `enqueue` holds any row that arrives for a held session (frozen from enqueue);
   - `releaseFold(foldId)` clears the session hold and releases the fold's rows, crediting the held span to each row's TTL and next-attempt time (`fold_frozen_ms`), NEVER to the pause cap (`total_frozen_ms`); a row still under an operator pause stays frozen and its pause span restarts at release;
   - `resumeFrozenRows` (operator resume) skips fold-held rows; `listTtlExpired` skips them and credits `fold_frozen_ms`; drain head selection already skips every frozen row.
   - This is the spec's "exempted from the `holdMaxMs < entryTtlMs` validator by reason": fold-held rows are not on the `holdMaxMs` ownership-hold path at all (they are frozen rows), so that validator never applies to them, and their bound is the fold record's (lock TTL ceiling + reconciliation).
2. **`src/monitoring/foldInboundHold.ts`** — `inboundHoldCarrier` (kind `inbound-hold`; the fold's terminal transition releases its rows), `releaseSettledInboundHolds` (after the inbound boot sweep opens the queue, rows whose fold record is terminal or missing are released; a non-terminal — including quarantined — record keeps them), `foldKeyForInboundSession` (Telegram id or `app:<key>` → the channel-neutral fold key from 8a).
3. **`src/core/inboundQueueBootSweep.ts`** — when the queue is dark at boot and gate-expires rows, fold-held rows are named in their loss reason (`gate:<gate> (held by fold <id>)`) and `onFoldRowsGateExpired(foldIds)` is called first, once per fold.
4. **`src/commands/server.ts`** — the carrier is registered with the coordinator (lazy store getter: the queue store opens in the inbound boot sweep, after the fold boot sweep); the settle pass runs right after the inbound sweep; the gate-expiry callback reports a named DegradationReporter row.

**On "the fold record moves to `rolled-back` on the same tick":** the fold boot sweep runs BEFORE the inbound boot sweep (slice 7, tested), so by the time a dark queue gate-expires a held row, every crashed fold is already terminal (aborted before the point of no return) or quarantined for the sentinel's rollback; the callback names the fold in the loss report on that same boot. The sentinel's rollback of a quarantined fold is task 10. <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel rollback of a quarantined fold whose held rows a dark queue expired) -->

**Phase 0 posture:** nothing calls `holdForFold` yet (the step runner is Phase 2), so no row is ever fold-held; the new columns and table stay empty and every queue path behaves as before.

## Decision-point inventory

- **Added:** whether a queued inbound message is deliverable while a fold holds its session. Deterministic over durable state; released only by the record.

## 1. Over-block

- Every message to a held session waits for the fold to end (by design, §9.3). The wait is bounded by the fold's lock TTL ceiling plus reconciliation, not by `holdMaxMs`.
- A claimed (in-flight) row is not held while it is in flight (a dispatch that completes is delivered, as with the operator pause); if that dispatch FAILS and the row returns to the queue (runtime retry or the boot sweep's claimed-row recovery), `release()` reads the session hold in the same transaction and the row comes back fold-held.
- A held session at its per-session cap refuses the new arrival (reason `max-per-session-fold-held`) instead of evicting a fold-held row; held rows still count toward the total bounds. A refusal is NOT a loss report: the router falls through to direct dispatch, so during a real fold that arrival would reach the session ahead of the held rows — the Phase 2 runner must gate the direct-dispatch fall-through on the fold hold (inert in Phase 0: nothing holds a session). <!-- tracked: CMT-1536 (Phase 2: direct-dispatch fall-through respects the fold hold for refused arrivals) -->

## 2. Under-block

- A quarantined fold holds its rows until the sentinel's rollback (task 10); nothing in the queue bounds that wait on its own. <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel rollback releases a quarantined fold's held inbound within the reconciliation bound) -->
- A carrier release that throws at runtime (e.g. SQLITE_BUSY) leaves the rows held until the next boot's settle pass; the sentinel's reconciliation tick re-runs the settle pass. <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel tick re-runs releaseSettledInboundHolds) -->
- A row paused first and then fold-held loses its pre-fold pause span from `total_frozen_ms` (it errs toward delivery).
- A torn or missing fold record releases its held rows at boot (`recordOpen` null ⇒ release): the direction toward delivering the user's messages, matching the coordinator's treatment of an orphan carrier.
- Slack, WhatsApp and iMessage messages do not pass this queue today, so their inbound is not held here; 8a's outbound hold covers their egress. <!-- tracked: CMT-1536 (Phase 1: channel-neutral inbound hold with the row writer) -->

## 3. Level-of-abstraction fit

Extends the queue's own freeze/TTL accounting instead of adding a second queue state machine; the release is a fold carrier, so the record owns the lifetime as §9.3 requires.

## 4. Signal vs authority compliance

Deterministic custody rule over durable state; no judgment; fails toward delivery when the record is missing.

## 5. Interactions

- **Operator pause:** independent of fold holds in both directions (resume skips fold rows; fold time never counts toward the pause cap; a release during a pause keeps the pause). Tested.
- **TTL and age checks:** a held row is never expired; after release its effective age excludes the held span in all three age checks (`listTtlExpired`, the drain's stale-custody clamp and its wake nap-stale check, which now subtract `fold_frozen_ms`).
- **Boot sweep gate-expiry:** named fold, callback first. Tested.
- **Drain:** head selection skips frozen rows (unchanged code path; the 182 existing queue unit tests and the queue lifecycle e2e pass).

## 6. External surfaces

None user-visible in Phase 0. A loss notice for a gate-expired fold-held row names the fold.

## 7. Multi-machine posture

Machine-local by design: the inbound queue's custody is the lease holder's (§3.5 of the queue spec), and folds run on the topic's owner; a pool with live placement cannot begin a fold (`owner-unknown`, slice 7).

## 8. Rollback cost

Revert. The added columns and table are additive and ignored by older code (SQLite tolerates extra columns; older code never selects them).

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: one settle pass per boot; release on a terminal transition; no loop or timer.

## Evidence

- `tests/unit/pending-inbound-fold-hold.test.ts` (11): held session invisible to the drain, others not; arrival during a hold is held from enqueue, including at an EMPTY held session; TTL frozen while held and credited after release; operator pause/resume never releases a fold row and fold time never counts toward the pause cap; release during a pause keeps the pause; release scoped to the named fold; additive migration on a pre-change database (idempotent second open); key mapping and carrier listing; `releaseSettledInboundHolds` releases terminal and missing, keeps open.
- `tests/unit/inbound-queue-boot-sweep.test.ts` (+2): gate-expiry calls the fold callback first, once per fold, while rows are still non-terminal, and names the fold in the loss; a throwing callback is logged and the expiry completes.
- `tests/integration/fold-inbound-hold-wiring.test.ts` (3): the real coordinator with the real queue: held while the fold runs, released only by the terminal transition; after a restart an aborted fold's rows are released by the settle pass and a quarantined fold's are kept.
- `tests/e2e/fold-inbound-hold-crash-lifecycle.test.ts` (3): a REAL child process holds the queue, receives a message, dies mid-fold; booting in the server's order releases it before the point of no return and keeps it held past it; wiring source check (carrier registered before the fold sweep, gate callback, settle after the inbound sweep).
- Existing: 8 queue unit files (182 tests), `inbound-queue-route` integration, `inbound-queue-lifecycle` e2e — all pass. `no-silent-fallbacks` at 494; `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10):** "Concern raised." BLOCKING: (1) a claimed row whose dispatch failed was released back to the queue UNHELD during a fold (runtime retry and the boot sweep's claimed-row recovery), so it would be delivered into the half-replaced context — reproduced; (2) only `listTtlExpired` credited fold-held time; the drain's stale-custody clamp and wake nap-stale check would expire a just-released held message as stale. MINOR: (3) a held row could be evicted at the per-session cap — reproduced; (4) no queue-side bound on a quarantined fold's hold, and "rolled-back on the same tick" is a report, not a transition; (5) a failed runtime carrier release strands rows until boot; (6) a pause span lost when pause precedes the fold — reproduced; (7) `holdForFold` was two autocommit statements; (8) the column check + ALTER races a concurrent opener and could quarantine a healthy queue; (9) no test drives the real drain loop with a hold.

**Resolution:** (1) fixed — `release()` applies the session hold inside its transaction (test: claim, hold, release ⇒ fold-held, invisible, released only by the fold); (2) fixed — both drain age checks subtract `fold_frozen_ms`; (3) fixed — held rows are never eviction victims; a held session at its cap refuses the arrival (test); (4) stated in §2 and tracked to task 10; the boot ordering argument for "same tick" is stated in the Summary; (5) tracked to task 10; (6) stated in §2 (errs toward delivery); (7) fixed — one transaction; (8) fixed — a duplicate-column error from a concurrent opener is tolerated, anything else still throws; (9) no existing queue test runs with a hold; the new release test covers the store path, and a hold-aware drain-loop scenario (including the two age checks) joins the verification suite. <!-- tracked: CMT-1536 (Phase 0 task 11: drain-loop scenario with a fold hold) -->

**Reviewer re-check (same reviewer):** "Concur with the review." Both blocking fixes verified in code (the new release test fails without the fix); items 4, 5, 6, 9 need not block. One correction applied before commit: the artifact said a refused arrival at a held session's cap is "reported" — it is not (the router falls through to direct dispatch); the wording now says so, the case has its own refusal reason `max-per-session-fold-held`, and the Phase 2 gating of that fall-through is tracked.

# Side-Effects Review — a user check-in no longer retires a held reply

**Version / slug:** `held-reply-user-checkin`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Incident, 2026-11-10 20:19 to 20:40 PST, topic 141014. Two session replies forwarded from the M5 standby to the Mac Studio (lease holder) were refused by the Studio's send capacity (`credential-capacity-unavailable`) and held for retry: operations `b60e9f1d` (prepared 04:19:07Z) and `003b93f8` (04:21:34Z). At 04:40:13Z the operator wrote "Checking in here". On the next recovery pass, `allowQueuedRecovery` asked `reviewQueuedReply`, `queuedReplyOvertaken` counted the operator's message as overtaking (`fromUser || provenance === 'agent'`), and both operations were set to `suppressed` with no hold reason. `listSessionDeliveryExceptions` excludes `suppressed`, so nobody was told. The authoring session had been told "outcome unknown, do not resend", so it did not resend either. The explanation the operator was waiting for was lost.

Evidence: the Studio's origin store (published as private view `origin-diag-141014`): both operations `suppressed`, with only `credential-capacity-unavailable` attempts, and no newer agent message in the topic between their drafts and the check-in.

The fix has three small parts:

1. `queuedReplyOvertaken` (`QueuedReplySupersession.ts`) now counts only a newer **agent** message (`!fromUser && provenance === 'agent'`). A user message alone never retires a held reply. The #2779 incident it was written for (a user answer **followed by** an agent correction) still retires, because the agent correction alone is enough. Its existing test is unchanged and still passes.
2. A retirement is now named: `allowQueuedRecovery` records `holdReason: 'overtaken-reply'` with the `suppressed` state. `OriginStoreBackend.recordOperationState` accepts that one reason on `suppressed` (no detail allowed) and stores it.
3. A retirement is now visible: `listSessionDeliveryExceptions` includes `suppressed` rows whose reason is `overtaken-reply`, so the periodic scan raises a record-only attention item through `reportSessionDelivery`. It gets NORMAL priority and plain copy ("A held reply was not sent because a newer reply reached the conversation first"), and never posts to the topic, not even from a live event.

Tier 1 by declaration: 6 source and test files, about 40 production lines, and a revert fully undoes it. One commit attempt so far. No spec review rounds (Tier 1).

## Decision-point inventory

- `queuedReplyOvertaken` / `reviewQueuedReplyHistory`: the retire-or-deliver decision for held session replies. The change only moves it toward **deliver**: user-only histories now return `deliver` (or `hold`, as before, when pool coverage is incomplete).
- `recordOperationState`: accepts one more named reason on an existing transition. The transition itself is unchanged.
- `reportSessionDelivery`: a new state value is recorded but never posted.

## 1. Over-block

None added. The change removes a block: user-only histories no longer retire a reply.

## 2. Under-block

A held reply can now be delivered after the user has written again with no agent reply in between. That is the intended trade: the user is waiting for it, and the module's own rule says a late reply costs less than one that never arrives. The existing late-reply labels (`lateRecoveredReplyNotice`, out-of-order detection) still apply to such a delivery.

A held reply is still retired once the agent has answered again, even if that later answer did not cover the held content. The authoring session still hears nothing directly. The retirement is now a durable, visible record (attention item plus named reason) rather than a silent drop. Telling the session itself would need cross-machine session injection, which is out of proportion here.

## 3. Level-of-abstraction fit

Right layer. `queuedReplyOvertaken` is the single predicate behind direct recovery and both forward schedulers (#2779), so the rule changes in one place. Visibility rides the existing delivery-exception scan and reporter rather than adding a parallel notifier.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`: this narrows an existing authority (retire) and does not add one. The new attention item is a signal with no blocking power.

## 4b. Judgment-point check

The predicate stays deterministic (message timestamps and authorship), which is appropriate: authorship is a recorded fact, not a judgment.

## 5. Interactions

- `withholdHistoricalDeliveryNotice` and the outcome-unknown reconciliation paths run before review and are unchanged.
- The exception scan already re-reads its rows each interval. `suppressed`/`overtaken-reply` rows join that scan (cursor-paged, bounded at 100 per page) and upsert the same attention id idempotently.
- `OriginOperationOutcome` already maps `suppressed` to "The server decided not to send it". That is unchanged and still true.
- The quiet-notification `suppressed` rows (`quiet-notification-recorded`) are still excluded from the scan. The new unit test proves only the `overtaken-reply` reason is listed.

## 6. External surfaces

A user may now receive a held reply after they have written again, which previously would have been dropped. A new attention item can appear on the dashboard, at NORMAL priority and never posted to Telegram. A new hold-reason string is stored. No routes, config or schema columns change.

## 7. Multi-machine posture

Machine-local by design, running on the execution owner. Retirement and the scan both run where the operation is stored (the holder for forwarded replies). The review already reads pooled topic history (`scope=pool`). That is unchanged, so authorship from every machine is seen.

## 8. Rollback cost

Revert the commit. Rows written with `hold_reason='overtaken-reply'` remain `suppressed` and are terminal either way. An older build simply ignores the reason. No migration.

## Conclusion

A narrow fix for the incident, with the retirement made visible. Ship.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent, 2026-11-11
**Independent read of the artifact: concur**

The reviewer checked four things. Callers: the only callers of `queuedReplyOvertaken` are `reviewQueuedReplyHistory` and the local fast path in `src/commands/server.ts` (~7682), and both only decide whether to return `retire`, so the change can only narrow retirement. Validation: `overtakenRetire` accepts only `suppressed` with the exact reason and no detail, the quiet path is unchanged, and the shared `suppressed` branch still moves queued children and entries. The exception scan: the new clause sits inside the existing state disjunction, the cursor and order are unchanged, and `outOfOrder` is computed only for accepted rows. Posting: the live path only emits `held`/`outcome-unknown`, and `reportSessionDelivery` returns before `sendNotice` for `suppressed`. The reviewer reran the tests: unit 694 passed / 1 skipped (61 files), and integration `session-delivery-reporting` 14 of 14. Minor note, not a blocker: retired rows stay listed and are re-upserted each scan, the same as the existing expired/failed rows.

## Evidence pointers

- `tests/unit/telegram-origin/queued-reply-supersession.test.ts`: the incident regression ("keeps a held reply when only the user wrote after it (a check-in)") fails on the old predicate (3 failures observed with the old line restored) and passes on the new one. Retire calls now carry `holdReason: 'overtaken-reply'`.
- `tests/unit/telegram-origin/session-exception-scan-bound.test.ts`: a retired reply is listed with reason `overtaken-reply` and a plain `suppressed` row is not. The reason is refused on non-suppressed states and with a detail.
- `tests/integration/session-delivery-reporting.test.ts`: a retired reply records a NORMAL attention item and posts nothing, even from a live event.
- `tests/unit/telegram-origin/*`: 61 files, 694 passed. `tsc --noEmit` is clean.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. This is a code defect in the delivery path, and the regression test is the guard.

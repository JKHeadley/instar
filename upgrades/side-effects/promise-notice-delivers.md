# Side-Effects Review — a check-in or late-promise line reaches the person

**Version / slug:** `promise-notice-delivers`
**Date:** `2026-11-18`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (below)`

## Summary of the change

The CMT-1923 live check (CMT-1951, 2026-11-18 15:44:49Z) showed that the late-promise line the reconciler "sent" was in fact recorded by Quiet by Default (`notification-selectivity.jsonl`: `decision: record, reason: quiet-default, category: uncategorized, sourceContext: src/server/routes.ts`). The reconciler ignored the quiet receipt, stamped `lateNoticeSentAt`, counted `late.topicsSent: 1`, and told the session "the user has been told it is late". Every dated check-in reminder went the same way. Changes: a new protected notification category `promise-notice` (`notificationCategories.ts`), a named producer stamper for it bound to `routes.ts` (`notificationStampers.ts`, admitted in `scripts/lint-notification-selectivity.mjs`), a gate rule that delivers it under a 6-per-topic-per-10-min backstop budget (`NotificationSelectivityGate.ts`), the reminder send in `routes.ts` stamped with it, the route's content reservation released on a quiet receipt, and `CheckInReminderReconciler.sendDelivered()` treating a quiet receipt as a failed send. Spec amended: `docs/specs/overdue-promise-follow-through.md` §3.2 "Delivery through Quiet by Default".

## Decision-point inventory

- `NotificationSelectivityGate.decide` — modify — adds a `promise-notice` branch (deliver within budget, else record).
- `CheckInReminderReconciler` send outcome — modify — a quiet receipt is now a failure (retry, then give-up), not a success.
- Check-in reminder route content dedup — modify — releases the reservation on a quiet receipt instead of recording it.

---

## 1. Over-block

No new block surface. The change delivers a category that used to be recorded. The reconciler now refuses to count a held send as sent; a legitimately delivered send (any non-quiet result) still counts as sent (tested).

---

## 2. Under-block

- The backstop budget (6 per topic per 10 min) is only a backstop; a bug in the reconciler's own caps could still send up to 6 lines in 10 minutes to one person. The reconciler's caps (one late message per topic per hour, 3 topics per pass, 12 per hour) are the real bound and are unchanged.
- When another machine holds the Telegram lease (relayed send), the category decision is made on the holder. The envelope's category travels with the relay as for every other envelope; not re-verified in this change.

---

## 3. Level-of-abstraction fit

Right layer. The category is the existing structural mechanism Quiet by Default uses to tell a conversation message from a report (same shape as `owner-decision` and `pairing-outcome`). The quiet-receipt check sits in the reconciler, the one place that turns a send outcome into "the user has been told", and uses the existing `isQuietReceipt` predicate, as ten other producers already do.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It removes an unintended hold on a fixed-template message; it adds no new judgment over message content.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The category is assigned by the producer's identity (an invariant: this producer only sends reminders about the agent's own promises), not by inspecting text.

---

## 5. Interactions

- Quiet by Default: `promise-notice` is in `PROTECTED_DELIVERY_CATEGORIES`, so it is not operator-configurable and never redirected to a push destination (same as `owner-decision`). It shows in the gate status category list with its own counters.
- Origin boundary: the send still goes through `runWithAutomationReply` with the same producer id and logical send id. With the category fixed, the gate delivers, so the replayed receipt is a delivered one.
- Give-up path: a held send now counts attempts and eventually stamps `lateNoticeFailedAt` / `checkInReminderFailedAt`, which raises the existing "reminders could not be delivered" attention item. A held send is therefore loud instead of silently counted as told.
- Session handoff: runs only after a real delivery, so its "the user has been told" stays true.

---

## 6. External surfaces

Yes, intentionally: the person now receives check-in reminders and late-promise lines in their topic. These were specified to reach them (dated-commitment-reminder and overdue-promise-follow-through specs) and were being held by mistake. Still behind `commitments.checkInReminder.dryRun` (default true). The Notifications settings page lists one more category, "Promises made to you", as not configurable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, unchanged: only the row's owner machine runs the late batch and sends (spec §5), so there is one voice per promise. The category is part of the envelope, not stored state. No new status surfaces, no URLs.

---

## 8. Rollback cost

Revert the commit. No stored state or migration. Rolling back makes reminders quiet again. The live switch `commitments.checkInReminder.dryRun: true` stops all reminder sends without a release.

---

## Conclusion

Clear to ship. The defect is two parts of one class: a person-facing reminder stamped as an automated report, and a held send counted as delivered. Both are fixed, and tests cover both sides of each boundary.

---

## Second-pass review (if required)

(appended below by the reviewer)

---

## Evidence pointers

- Live: `.instar/logs/notification-selectivity.jsonl` line 877 on the Studio (15:44:49.406Z, topic 144400, record / quiet-default / uncategorized); CMT-1951 `lateNoticeSentAt 15:44:49.256Z`, `lateNoticeCount 1`; feedback fb-f3ff81ab-363.
- Unit: `tests/unit/promise-notice-delivery.test.ts` (8): category registered and protected; the old envelope records and the new one delivers (the CMT-1951 decision); budget per topic; routes wiring; a quiet receipt leaves late and check-in rows unstamped with no handoff; a delivered result still counts as sent. Existing `late-notice-reconciler`, `check-in-reminder-reconciler`, `notification-owner-decision-category`, `notification-selectivity`, `notification-pairing-outcome-category` pass.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`**: `unbounded-self-action`
- **`closure`**: `guard`
- **`guardEvidence`**: `{enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the check-in reminder pass is registered (selfActionRegistry checkInReminderPass). The only new self-action is a retry when a send is held quiet; it reuses the existing per-time attempt budget (LATE_NOTICE_MAX_ATTEMPTS 5, CHECK_IN_MAX_ATTEMPTS) and then stamps lateNoticeFailedAt / checkInReminderFailedAt, which removes the row from eligibility (the brake). Steady state: at most 3 topics per pass, 12 per hour, one late message per topic per hour, and a gate backstop of 6 promise-notice sends per topic per 10 min.}`

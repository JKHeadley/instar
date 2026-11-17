# Side-Effects Review — owner decisions are delivered by Quiet by Default

**Version / slug:** `cos-owner-decision-delivery`
**Date:** `2026-11-16`
**Author:** `echo (session echo-echo-topic-management-137342)`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass reviewer response)`

## Summary of the change

Quiet by Default recorded every `TelegramAdapter.sendOfferList` send in the quiet feed, because the offer carried no category. Those sends are the Chief of Staff note with Unpark / Confirm-done buttons, the Chief of Staff owner-pause ask, and the machine-enrolment offer. On Echo, 40 were recorded quiet in one evening. A new protected category `owner-decision` is now delivered, capped at 10 per topic per 10 minutes. The only producer is `sendOfferList`, and it stamps the category only when the caller did not stamp an envelope of its own. Separately, the owner-pause source floor now refuses a marker whose date is not the cited message's UTC date (`date-mismatch`).

Spec: `docs/specs/cos-owner-decision-delivery.md` (Tier 1; approved by echo-chief-of-staff as maintainer, message f09e5a62). Files: `src/messaging/notificationCategories.ts`, `src/messaging/NotificationSelectivityGate.ts`, `src/messaging/TelegramAdapter.ts`, `src/core/cosOwnerPauseSource.ts`, tests. About 25 lines of source. Effort: one spec pass with the conformance check, one commit.

## Decision-point inventory

- Quiet by Default: `owner-decision` now delivers (`owner-decision`); past the budget it records (`owner-decision-budget`).
- Owner-pause ask source floor: a marker date that differs from the logged row's date is refused.

## 1. Over-block

- An eleventh owner decision to one topic within 10 minutes is recorded quiet, not delivered. No real producer comes near that: the Chief of Staff caps itself at 3 immediate messages a day, the enrolment offer is sent once, and a pause ask replaces the project's earlier ask.
- A marker with the right message id but a wrong date is refused. The agent copies markers from `/attribution/find` and `/attribution/trace`, which write the UTC date, so only a hand-edited marker trips this.

## 2. Under-block

- Any in-process caller that sends an unstamped offer list is now delivered. Today every unstamped caller is an owner-tap flow. A future report sent through `sendOfferList` would be delivered too; the budget bounds that, and the code comment names the rule.
- The recommended-services offer list stamps its own envelope and is unchanged, so it stays subject to its own category's rule.

## 3. Level-of-abstraction fit

The category sits in the existing category registry and the existing gate, next to `pairing-outcome`, the other protected owner-facing category. The stamp sits in the one function every owner-tap offer already goes through, not in each caller.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. This removes a block (the gate no longer quiets owner decisions). The two remaining blocks are exact-fact checks: a count per topic per window, and the equality of two dates from logged records. No heuristic or LLM holds authority.

## 4b. Judgment-point check

The conformance gate raised Judgment Within Floors on the budget. The budget is a floor against a looping sender, and what it holds back goes to the visible quiet feed, not nowhere. Answered in spec §Standards-Conformance Gate.

## 5. Interactions

- `PROTECTED_DELIVERY_CATEGORIES` gains `owner-decision`. As a result, `POST /notifications/categories/owner-decision/push` is refused, the dashboard shows it as not configurable, and `destination()` never redirects it to a push channel.
- The lifeline's verdict validation accepts it, since it is a registered category.
- `sendOwnerDMWithButton` is unchanged; it was already delivered as `verified-mobile-approval`.
- The Chief of Staff note's `note-with-buttons-failed` path now succeeds, so held notes deliver on the next tick.

## 6. External surfaces

The owner now receives the Telegram offers that were silently held: the Chief of Staff note buttons, pause asks and the enrolment offer. A new row appears in the notification categories list ("Decisions only you can make"), not configurable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the gate decides on the machine that sends. Only the Telegram-polling machine sends these offers (the existing one-reader and lease rules). The budget is per machine, which is acceptable for a flood bound.

## 8. Rollback cost

Revert the commit. Offer lists go back to being recorded quiet. Nothing is stored or migrated.

## Conclusion

Small and reversible. Owner decisions reach the owner, routine reports stay quiet, and no request can claim the category.

## Second-pass review (if required)

Required (block/allow decision on outbound messaging).

## Evidence pointers

- Unit: `tests/unit/notification-owner-decision-category.test.ts` (6: registry, gate deliver vs quiet-default, budget per topic, not configurable / no push redirect, adapter delivers an unstamped offer while a plain report stays quiet, a caller-stamped envelope is kept), `tests/unit/cos-owner-pause.test.ts` (+1 date-mismatch). Neighbours: `notification-selectivity` (28) and `notification-pairing-outcome-category` (4) pass.
- Live, 2026-11-16 22:5x PST: the branch's built `TelegramAdapter` and gate (enabled, enforcing) with the real Bot API and a broker-made test group "Instar test - owner decision delivery" (bot @instar_pr2760_livetest_bot). The routine report was recorded quiet (`quiet-default`, `uncategorized`) with no Telegram call. The offer was delivered (`owner-decision`), and Telegram returned message id 3. The group was deleted afterwards. Driver: `.instar/lanes/owner-decision-proof/proof.mjs` in the agent home.
- The defect, observed live on 1.3.1860 at 22:14 PST: `sendOfferList failed: Notification recorded in the quiet feed`, with 40 rows `record/quiet-default/uncategorized/telegram-server` for topic 141385.

## Second-pass reviewer response

**Verdict:** Concur with the review

Checked independently. `tsc --noEmit` is clean, and 58 tests pass across the four notification and owner-pause test files.
- No path outside the server process can produce `owner-decision`. A peer machine's signed relayed origin is the same trust class as `pairing-outcome`.
- Every unstamped `sendOfferList` caller is an owner-only tap. Enrolment taps are checked through `fromIsOwner`, and `cos:` taps are owner-gated in the adapter.
- The budget and the tap-time recheck (`date-mismatch` gives `recheck-failed`) are sound.

Findings, none blocking:
1. **Low.** The pause ask's quote-first message, with no buttons, is also `owner-decision`, so one long ask uses 2 of the 10-per-topic budget. Accepted, because the quote is half of the ask.
2. **Low, latent.** An offer sent from inside an inbound-message handler would inherit that handler's conversation category. No caller does this today. **Applied:** a comment at `sendOfferList` warning against it.
3. **Low.** The date check converted the timestamp to UTC, while the attribution code slices the raw stored string. **Applied:** the check now slices the raw timestamp, the same way `findSources` does.

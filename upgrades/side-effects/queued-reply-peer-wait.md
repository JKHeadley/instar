# Side-Effects Review — bounded wait for an unreachable machine on a retried reply

**Version / slug:** `queued-reply-peer-wait`
**Date:** `2026-11-07`
**Author:** `echo (builder echo-land-three)`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1, one condition and one constant in `src/messaging/telegram-origin/QueuedReplySupersession.ts`, plus tests. `reviewQueuedReplyHistory` answered `hold` whenever `failedPeers` was non-zero, with no limit. It now holds only until `QUEUED_REPLY_PEER_WAIT_MS` (15 minutes) after `preparedAt`; past that, a failed peer no longer holds. Found on op ece51280: every recovery try stopped silently at this review because the Laptop answered HTTP 530, and the reply would have expired at its 6-hour deadline.

## Decision-point inventory

- `reviewQueuedReplyHistory` (retire / deliver / hold for a retried session reply): modified. Only the failed-peer branch changes. The retire checks run first and are unchanged; the no-pool and full-page holds are unchanged.
- No new decision point.

## 1. Over-block

This reduces over-block: a reply no longer holds to expiry behind one unreachable machine. Remaining holds: pool read failed, malformed answer, full page. Those can still hold to expiry and are not changed here. One can follow from machine absence: a hung peer aborts at 5s against the caller's 6s limit, and missing that margin is a hold the bound cannot end.

## 2. Under-block

After the bound a reply can go out although a newer message exists only on the machine that cannot answer. This reverses a recorded choice: `upgrades/side-effects/queued-reply-coherence.md` holds when evidence is absent, after the 11-04 incident where a reply landed 28 minutes late over the operator's answer. That incident's case stays covered, because a newer message visible locally or on any answering machine still retires the reply. What is given up is only a newer message held solely by the unreachable machine; the alternative measured here is a reply lost at its deadline, with a dashboard record but no message to the person. The bound is on a reply at least 15 minutes old with a known blind spot, which is a weaker position than a first send.

## 3. Level-of-abstraction fit

The bound sits in the pure review function beside the other retire/hold rules, with an injectable clock, so both sides are unit-tested. The recovery loop and its review schedule are untouched.

## 4. Signal vs authority compliance

No new blocking authority; this narrows an existing hold. Evidence of a newer message keeps its authority to retire.

## 4b. Judgment-point check (Judgment Within Floors standard)

A fixed time bound, not a judgment: it decides only when to stop waiting for a peer, and carries no content decision.

## 5. Interactions

- Reviews run about 0, 0.5, 1.5, 3.5, 8.5, 23.5 and 38.5 minutes after the first, so a direct reply is released at about 24 minutes, not 15. The forward ladder does not use this schedule and can release nearer 15.
- Releasing an older reply can retire a newer queued one in the same topic: the recovered message is logged as an agent message later than the newer draft, and the newer one becomes `suppressed`, which leaves no record at all. That supersede rule already exists; the bound newly reaches it in the dark-peer case. Traced by reading, not run. Filed.
- `max_attempts` counts transport attempts; held reviews never consumed them, so nothing is lost by the earlier holds.
- The bound runs from the draft time, not from the first failed read. So any reply already past it, including imported legacy rows, gets no wait: one passing peer failure releases it on that sample, where the next review would earlier have retried with full evidence. Accepted for simplicity; a first-failure clock would need new durable state.
- `now` defaults to `Date.now()`, so the `server.ts` caller needs no change.

## 6. External surfaces

None: no route, config or message format changes. A retried Telegram reply can arrive where it previously did not.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. The silent retries remain unlogged; filed as feedback together with the misleading first-send label.

## 7. Multi-machine posture (Cross-Machine Coherence)

This is the multi-machine case: with a dark peer, the machine holding the reply decides alone after the bound. A peer that answers is still consulted. No state is shared or changed.

## 8. Rollback cost

One revert, no migration or data change.

## Conclusion

Safe to ship as a deliberate trade: it gives up one narrow blind-spot case to stop silent loss, and leaves evidence-based retirement alone.

## Second-pass review (if required)

**Reviewer:** independent subagent (echo-land-three, 2026-11-07), with the author's review in hand as its brief asked, tracing each claim to the code.

First pass raised a concern: no code bug, no duplicate path, but the 15-minute claim was false (about 24 in practice), the older-retires-newer interaction was undisclosed, and the reversal of the 11-04 decision was not owned. It also noted the draft-time clock, a missing default-clock test and the 5s/6s margin. All were corrected here, and the reviewer then concurred. Its two later wording notes ("no notice" and the closure reason) were applied after that. Not done, judged non-blocking by the reviewer: a test driving a release through `allowQueuedRecovery`, and a test of the older-retires-newer path, which belongs with its fix. Not verified by the reviewer: the ece51280 store row.

## Evidence pointers

Store row for ece51280 (recovery schedule attempts 6, child queued), `GET /telegram/topics/136110/messages?scope=pool` with pool.failed naming the Laptop at HTTP 530, four same-chat deliveries after the hold. Tests: `tests/unit/telegram-origin/queued-reply-supersession.test.ts`.

## Class-Closure Declaration (display-only mirror)

```json
{ "defectClass": "unbounded-hold", "closure": "n/a",
  "reason": "Bounds the one failed-peer hold found; the other holds in this review stay, and the one that can follow from machine absence is named in section 1." }
```

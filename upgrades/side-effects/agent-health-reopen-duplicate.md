# Side-Effects Review — a reopened agent-health notice held as a duplicate counts as delivered

**Version / slug:** `agent-health-reopen-duplicate`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (narrow error classification on one notice path)`

## Summary of the change

ACT-1304 fault 2 (reported by Luna/sagemind). Luna's laptop log, 2026-10-04 12:05-12:18Z: `Threadline.SpawnDrainAttention: Attention write failed: Telegram message held: duplicate-content`, every 30 s for 13+ minutes. The spawn drain's give-up handler calls `TelegramAdapter.createOrReopenAgentHealthAttentionItem`; once the item exists, each call reposts a fixed "returned after recovery" line to the Agent Health topic. The outbound dedup held each repost as a duplicate of the copy already accepted in that topic, the adapter rethrew the hold, and the spawn manager treated it as a failed Attention write and retried. Now a `TelegramOriginHoldError` with reason `duplicate-content` on that reopen post is treated as delivered; every other hold still throws so the caller retries as before.

## Decision-point inventory

None added. The dedup gate's decision is unchanged; this changes how one caller interprets "already delivered".

## 1. Over-block

Nothing new is refused.

## 2. Under-block

`duplicate-content` is returned only when the same text to the same topic was platform-accepted within the dedup window (`OriginContentDedup` returns `content-reservation-pending` for an in-flight copy, which still throws), so the operator has the notice. Other holds (for example `origin-display-authority-unavailable`) still fail and retry.

## 3. Level-of-abstraction fit

The adapter owns this send and knows the hold reason; the spawn manager stays generic.

## 4. Signal vs authority compliance

No authority added; the dedup gate keeps its authority.

## 4b. Judgment-point check

Not a decision point.

## 5. Interactions

Ends the 30 s retry loop and its degradation-log noise. The first-creation path already swallowed send errors. Other `sendToTopic` callers are untouched.

## 6. External surfaces

No new message is sent; a duplicate stays suppressed.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local; the Agent Health lane and the dedup are per machine.

## 8. Rollback cost

Revert; no state change.

## Conclusion

A one-branch error classification that stops a retry loop on a notice the operator already has.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "Adds no self-triggered action: it classifies a duplicate-content hold on one notice as already delivered, which REMOVES the trigger for the callers 30s retry loop. Other holds still throw, bounded by the spawn drain existing give-up latch."}`

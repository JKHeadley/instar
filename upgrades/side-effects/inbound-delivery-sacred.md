# Side-Effects Review — Inbound Delivery Is Sacred (Postmortem F3)

**Version / slug:** `inbound-delivery-sacred`
**Date:** `2026-06-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not-required — Phase 5 triggers on a block/allow DECISION on inbound messaging; this makes no block/allow decision (it is loss-notice delivery ROUTING, no authority added), runs only while the queue is dark, and is backed by a pure unit-tested router. Rigor is the 6-case unit suite + this review.`

## Summary

Routes inbound-queue loss notices to the ORIGINATING topic (each loss item's
`sessionKey` is the topic id) instead of the single `agent-attention-topic` that
`notify()` silently drops when unset. A loss with no resolvable topic and no
attention topic surfaces LOUDLY (`console.error`) instead of vanishing. New pure
function `planInboundLossNotices` (`src/core/inboundLossRouting.ts`) + a thin
`notifyInboundLoss` helper in server.ts, applied to all 5 inbound-queue loss sites.

## The 8 questions

1. **Over-block** — N/A. This is not a gate; it adds no block/reject. It only
   changes WHERE a loss notice is delivered. It cannot reject a legitimate message.
2. **Under-block** — N/A (no blocking). The failure mode it closes is *under-notice*
   (a silent drop), which is exactly what it fixes.
3. **Level-of-abstraction fit** — Correct layer. The loss is detected in
   `QueueDrainLoop` (already complete); the DELIVERY of the notice is a server-bootstrap
   concern (where `notify` + the attention-topic state live). The grouping logic is
   extracted to a pure, testable core (`inboundLossRouting.ts`); server.ts only does
   the side-effecting notify/console.error. Right split.
4. **Signal vs authority** — Pure signal-delivery. No blocking authority added. The
   pure router holds no authority; the helper only emits notices. Complies with
   `docs/signal-vs-authority.md`.
5. **Interactions** — Reuses the existing `notify()` funnel (batcher, attention
   topic, Slack mirror) — does not bypass it, only passes a `topicId` so it lands in
   the originating topic. The `stuck-recovery` notice already routed per-topic and is
   UNCHANGED. No double-fire: each loss item is counted once, per topic.
6. **External surfaces** — Changes the destination + wording of a user-facing loss
   notice (now per-topic, drops the redundant "topics:" list). It depends on the loss
   item's `sessionKey` being the topic id (verified — that is how the queue keys
   custody). No new external dependency.
7. **Multi-machine posture** — Machine-local BY DESIGN. Each machine reports the loss
   of the messages IT held; the notice goes to the originating topic on that machine's
   Telegram path. No replication needed (a loss is a local custody event). The
   attention-topic fallback + loud `console.error` are also machine-local.
8. **Rollback cost** — Trivial. The change is inert while the inbound queue is dark
   (default). Revert is a code-only back-out (no migration, no state). The queue's
   loss-DETECTION is unchanged; only the notice routing differs.

## What it does NOT do

- Does not change the queue's loss-detection, retry, or expiry logic (all already
  complete). It only hardens the notice *channel*.
- Does not touch the fail-OPEN direct-inject fallback (already comprehensive).
- Does not run while the queue is dark (default) — zero behavior change on the fleet.

## Rollback

Revert the commit. No persisted state, no migration. Inert while `inboundQueueConfig`
ships `enabled:false`.

## Second-pass reviewer verdict

Not required — see the header rationale (no block/allow decision; delivery-routing only;
dark; pure-function-backed). The decision boundary is covered by the 6-case unit suite.

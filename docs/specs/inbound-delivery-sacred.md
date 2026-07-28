# Inbound Delivery Is Sacred — loss notices reach the user (F3)

**Status:** draft (Tier-1 instar-dev; the PR is the review surface).
**Constitution:** *The User Experience Is the Product* → sub-standard #3 **Inbound Delivery Is Sacred**.
**Earned from:** 2026-06-25 (postmortem Failure 3) — the durable inbound holding-queue captured the user's Telegram messages "to keep them safe", then expired them after retries WITHOUT the user ever hearing about it. "Why aren't you responding?" died in the queue.

## What already exists (do NOT rebuild)

A codebase sweep (2026-06-26) found two of the three things the postmortem implied are missing are already in code:

1. **Loss-detection is complete.** `QueueDrainLoop` calls `reportLoss`/`reportPossiblyNotInjected` on EVERY terminal-expiry path (ttl-expired, attempts-exhausted, stale-custody, poisoned, overflow, …). No silent drop in the queue engine itself.
2. **The fail-OPEN fallback is comprehensive.** The Telegram inbound handler falls through to the direct-inject path on every uncertain case (dry-run, not-lease-holder, storage-failure, dark engine, route-throw). The corollary "a half-built net fails OPEN, never capture-and-drop" is satisfied in code.

## The actual gap (what this fixes)

The loud-failure **channel**. Every loss report funnels into `notify(tier, category, message)`, which resolves the destination to a single `agent-attention-topic` state key — and **silently skips the Telegram send when that key is unset** (`resolvedTopicId === 0`). Loss notices were also SUMMARY-batched and routed to the attention topic, **never to the topic the user actually messaged from**, even though every loss item carries `sessionKey` (the originating topic id).

So a lost inbound message could still die quietly: if no attention topic is configured, the "I didn't get to your messages" notice is dropped.

## The change

A pure router + a thin server helper, applied to every inbound-queue loss-notice site:

- **`planInboundLossNotices(items)`** (`src/core/inboundLossRouting.ts`, pure + unit-tested): groups loss items by `Number(sessionKey)` → `{ perTopic: [{topicId, count}], unresolved }`. A non-numeric/zero/negative sessionKey is `unresolved` (never silently assigned to a topic).
- **`notifyInboundLoss(items, tier, buildMessage)`** (server.ts): emits a per-ORIGINATING-topic notice (`notify(tier, 'inbound-loss', msg, topicId)`) so each user hears about THEIR lost messages, in THEIR topic, on the proven Telegram path. Items with no resolvable topic fall back to the attention topic; if that is ALSO unset, the loss is surfaced **loudly** (`console.error`) — the one seam where a loss could otherwise go silent is closed.
- Applied to all 5 inbound-queue loss sites: boot-sweep `reportLoss`/`reportPossiblyNotInjected`, the no-mesh-identity dropped path, and the drain-loop `reportLoss`/`reportPossiblyNotInjected`. (The `stuck-recovery` turn-incomplete notice already routes per-topic — unchanged.)

## Scope / safety

The inbound queue ships **dark** (`inboundQueueConfig` `enabled:false`), so this code only runs when the queue is explicitly enabled — it hardens the channel for when it IS live, with no behavior change while dark. No new blocking authority; this is a delivery-routing change (a signal-delivery improvement, not a gate).

## Tests

- Unit: `planInboundLossNotices` — routes to originating topic, unresolved counting, zero/negative/non-numeric → unresolved, deterministic order, empty input. (6 cases.)
- The server helper's loud-fallback path is covered by the side-effects review + the pure-function unit tests (the `unresolved` branch is the one console.error surface).

## Reconcile (open)

At v1.3.671+ the queue ships dark, so the production capture-and-drop the postmortem observed was likely the PendingInjectStore path or a non-dark deploy — worth confirming which holding-queue was live during the incident. This change hardens the inbound-queue channel regardless.

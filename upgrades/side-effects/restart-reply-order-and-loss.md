# Side-Effects Review — Replies after restart

**Version / slug:** `restart-reply-order-and-loss`  
**Date:** 2026-11-04  
**Author:** Echo  
**Second-pass reviewer:** independent agent, concurred after follow-up

## Summary of the change

Tier 1, narrow reversible repair: the legacy delivery sentinel selects the oldest queued reply in a topic; the origin outbox pages through durable session delivery exceptions after a restart; the server posts plain, deduplicated Attention and conversation notices for held, failed, or uncertain replies and marks a reply whose Telegram receipt number proves a newer answer overtook it, or whose acceptance was confirmed at least five minutes after preparation. Runtime changes are in the sentinel, origin store/service/runtime, and server wiring, with targeted tests. Roughly 10 source/test/documentation files and 150 lines; two focused review passes and two commit/gate attempts. The existing retry and receipt authority stays intact.

## Decision-point inventory

- Legacy queue selection — modified — oldest queued row wins within a topic, except the explicit stampede policy.
- Session delivery exception read — added — pages through durable session `sendMessage` operations with unresolved delivery evidence; it also scans accepted session replies after the rollout cutoff, closing prior alerts on timely acceptance and explaining acceptance that took at least five minutes.
- Notice wording — added — derives delayed, failed, or uncertain wording from durable transport state; it does not infer message content.
- Origin retry/receipt decisions — passed through unchanged.

## 1. Over-block

No new message block. Older queued rows may take longer to drain when the topic has a backlog; the existing per-topic pacing already limits recovery to one row per tick. The stampede rule remains unchanged.

## 2. Under-block

A total storage failure can leave only an in-memory hold, which disappears on a crash; the immediate Attention callback is then the only evidence. If both Telegram delivery and Attention storage fail, the notice cannot reach the person until those systems recover. The patch does not assert an unknown attempt was lost and cannot reconstruct its text after expiry.

## 3. Level-of-abstraction fit

Queue order belongs in the sentinel selector. Durable exception reading belongs in the origin store worker. Human notices belong in the server's existing Telegram/Attention authority. No parallel retry loop or new receipt authority is added.

## 4. Signal vs authority compliance

Required reference: [signal-vs-authority](../../docs/signal-vs-authority.md). No brittle content blocker is added. Transport states are enumerable mechanical facts; the existing tone and send policy still govern notice delivery. The notice says “cannot confirm” for unknown outcomes, never “lost” as a fact.

## 4b. Judgment-point check

No competing-signals judgment heuristic is added. The state mapping is a fixed transport vocabulary, and it never chooses whether to resend uncertain content.

## 5. Interactions

- Shadowing: the origin outbox replaces the legacy drain when enabled; the two do not both execute one row. The legacy ordering fix is for installs still using that path.
- Double-fire: Attention ids use the original operation id. Topic sends use a stable logical id per operation and state, so a repeated check can reattempt a notice without duplicating a confirmed send. An order notice requires durable Telegram message ids for two `sendMessage` replies in the same account and topic. Edits are excluded because they reuse message ids. A time-only late notice requires acceptance confirmation at least five minutes after preparation; it does not assert Telegram arrival time.
- Races: the durable sweep repairs a crash between outbox recording and the immediate callback. It reads evidence only and never claims or replays the original reply. Notice sends go through the origin automation path. The scan runs after the recovery drain without blocking it.
- Feedback loops: a notice is server automation, so it does not trigger the session-reply alert callback.

## 6. External surfaces

Telegram conversation and Attention hub receive plain notices. No raw reply text appears in an alert. A topic notice uses the existing send path, so it can itself be delayed; the Attention item persists. No operator action is introduced. The response and outbox schema are unchanged.

## 6b. Operator-surface quality

No dashboard form or renderer is touched. Notices use short sentences with no identifiers in the primary text and fit a phone conversation.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design for outbox evidence: only the machine that prepared the operation can read its authoritative record. The serving lease and existing forward path keep a standby from replaying it independently. Conversation notices use the existing Telegram owner/lease send path; Attention uses existing hub routing. No URLs are generated. A topic transfer does not erase the source machine's durable outbox; a transfer while that machine is permanently unavailable remains visible through existing pool health, not repaired by this patch.

## 8. Rollback cost

Revert and ship a patch. No schema migration or state cleanup is needed. Already sent explanatory notices remain in Telegram; rollback cannot retract them.

## Conclusion

The fix gives the person an explicit explanation when a reply cannot be confirmed, and the legacy queue no longer reverses ordinary pending replies. It keeps the existing no-blind-resend rule. Targeted red/green regression, unit, integration, and TypeScript checks passed. The independent high-risk review concurred after the retry and cursor corrections.

## Second-pass review

**Reviewer:** independent review agent  
**Independent read of the artifact:** Concur with the review. The durable cursor, stable notice id, nonblocking scan, accepted-reply alert closure, and position-neutral wording address the identified risks. The follow-up review concurred with the receipt-number overtaking query and edit exclusion. The follow-up review also concurred with receipt-number order detection and edit exclusion. A targeted HTTP notice retry test is not included; the origin automation route and idempotent send behavior are existing paths.

## Evidence pointers

- Real incident: topic 136110, operation `8d27c595-47c9-4d1f-9047-d5623003b105` accepted at 02:27 UTC after earlier failures; `61a239de-8d71-4a50-9c30-af33207c7bf8` expired with an unknown attempt.
- `tests/integration/sentinel-recovery.test.ts`: oldest-first test failed before the selector change and passed after.
- `tests/unit/telegram-origin/recovery-fairness.test.ts`: durable exception query covers unknown and delayed queued session replies, accepted-reply alert closure candidates, and cursor paging.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. This change extends the existing recovery controller with an observe-and-notify edge. The durable read is paged in batches of 100 with no age limit for unresolved rows; a cursor advances through the backlog. Stable logical send ids and a confirmed-acceptance check are the settling brakes. The transport retry edge is unchanged. The class-level guard is the targeted regression tests plus `tests/unit/self-action-convergence.test.ts` for the general controller rule.

# Side effects review: standby Telegram replies

## Decision and tier

Tier 2 repair to the approved Telegram Message Origin and A2A single-agent identity designs. This changes the evidentiary threshold for delivered and records confirmed recovered replies in topic history. It does not weaken the holder lease fence. Rollback is a code release; existing origin records remain readable.

## 1. Over-block

A forwarded acceptance without a safe Telegram message ID, or a single-ID receipt for a multipart operation, is now refused by the standby store and stays held or unknown. An older holder implementation that omits IDs cannot be counted as delivered even if it actually sent. This is the safe choice for delivery truth; receipt recovery can later resolve it when the ID is available.

## 2. Under-block

A holder can send and crash before recording its Telegram response. That outcome remains unknown, and the bot API has no read-by-message-ID query. A transient store read failure after confirmed delivery could still omit the local history row; the origin receipt stays durable and can be reconciled. A refused standby receipt write keeps the hold in outcome-unknown and checks the holder before any further submission. The prior 503 `origin-config-secret-source-unavailable` was seen during a version transition, but its precise nested cause was not exposed by the old worker and is not claimed fixed here. Live verification will determine whether it persists.

## 3. Level of abstraction

The origin store validates receipt evidence at its acceptance boundary, and the outcome reader uses the same concrete ID rule. The recovery callback writes history only after the store confirms delivery; it never sends another Telegram message. The existing lease holder remains the one outbound authority.

## 4. Signal versus authority

A message ID returned by Telegram is delivery evidence. This change prevents a transport acknowledgment without an ID from gaining delivered authority. `confirmedRecoveredForward` is a read-only projection of origin evidence; it cannot permit an outbound send. The lease and policy gate still decide whether the holder may send.

## 5. Interactions

The store's accepted receipt, origin outcome route, and forwarded receipt response now agree. A superseded hold points to its replacement operation before history is written. `recordRecoveredOutbound` writes the session machine's topic log and never calls Telegram. Existing accepted operations with empty receipts will read unknown after this release instead of false delivered.

## 6. External surfaces

A held reply outcome may change from delivered to unknown when its receipt lacks an ID. This is intentional correction. The operator sees the original reply in the topic history after confirmed recovery. The fixed hold notice and one-voice gating remain unchanged. No operator form changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Proxied send through the lease holder, with durable held state on the originating standby. The holder owns the Telegram send and its receipt. The standby resolves the receipt and writes its own topic history row. A dark holder leaves the outcome unknown and the reply held; it never causes a second voice. Topic transfer and holder transfer use the existing supersession link. The 15-minute recovery row retains the session producer kind for correct topic history provenance. No new persisted URLs or user notices are introduced.

## 8. Rollback cost

Code-only hot-fix release. The origin store schema is unchanged. Reverting the history write may remove future recovered rows but cannot unsend Telegram messages. Reverting the ID requirement would reintroduce false delivered answers and is not recommended.

## Independent review

Reviewer found that the 15-minute history row lost its producer kind, forwarded acceptance could treat a multipart operation as one delivered message, and pre-send custody markers could be refused without stopping a send. All three were corrected. Receipt IDs are now constrained to safe integers, and the integration fixture supplies an actual Telegram ID. Same-holder, transferred-holder, and local-send refusal tests verify a failed marker never sends. Reviewer rechecked the revised code and concurred.

## CI reconciliation after main merge (2026-11-04)

Two older fixtures still treated an accepted attempt with an empty receipt as confirmed delivery, or expected a receipt response without its Telegram message ID. Those assertions failed in both Node unit shards and Integration Tests before this update. They now require the concrete `321` ID returned by the fake Telegram API and a valid ID in the unit receipt. No runtime decision or durable format changed in this reconciliation; the original review above still describes the behavior.

## Local verify repair (2026-11-04)

The e2e messaging suite passes with an isolated writable home (94 passed, 1 skipped). Receipt parsing now rejects an entire multipart receipt if any member lacks a valid safe Telegram ID, so a partial receipt cannot make one part appear complete. The store already rejects a forwarded acceptance unless exactly one child is queued. The focused outcome test passes. Independent re-review concurred.

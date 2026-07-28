# Side-Effects Review — Slack delivery-id idempotency + pre-POST mint + 409 Arm C

**Version / slug:** `slack-outbound-robustness-slack-delivery-id`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The Slack lane of the double-post fix + R8-M1 Arm C (spec §2.4 / §2.6):

1. **`/slack/reply` delivery-id idempotency (§2.4).** The route now reads `X-Instar-DeliveryId`; a repeat POST with a seen id returns `200 { idempotent: true }` WITHOUT re-sending. The id is recorded ONLY after a successful send (a failed send — including the ambiguous 408 timeout — never poisons the id, so its legitimate retry still delivers). Mirrors the deployed `/telegram/reply` behavior, reusing the same route-scoped LRU helpers.
2. **`slack-reply.sh` pre-POST mint (task 2).** The script mints the UUID BEFORE the first POST and sends it as `X-Instar-DeliveryId` on the initial send — so the server records THAT id the moment the send lands, closing the first-attempt double-post window the deployed headerless send left open. A mint failure degrades to today's headerless send (fail toward delivery).
3. **`slack-reply.sh` 409 → NON-LOSING (Arm C).** A structured `409 { error: 'delivery-in-flight' }` (the §2.4 reservation race) is non-losing: the script does NOT re-send (the in-flight call under the same id owns delivery) and does NOT drop — exit 0. An UNSTRUCTURED 409 is a genuine conflict → terminal exit 1.

**Migration Parity:** a new `slack-reply-feature: delivery-id` marker is added to the script and set as the `migrateReplyScriptTo408` `featureMarker`, so a deployed thread-ts-arg-only slack-reply.sh is refreshed on update (the new template contains BOTH markers).

Files touched: `src/server/routes.ts` (`/slack/reply` delivery-id read + record), `src/templates/scripts/slack-reply.sh` (marker, pre-POST mint, 409 branch), `src/core/PostUpdateMigrator.ts` (featureMarker bump), `tests/integration/slack-reply-delivery-id.test.ts`, `tests/unit/slack-reply-delivery-id-script.test.ts`.

## Decision-point inventory

- `/slack/reply` delivery-id read/record — add — idempotent-200 on a seen id; record only after success. Reuses the existing `deliveryLruHas`/`deliveryLruRecord` (route-scoped, TTL-aware).
- `slack-reply.sh` pre-POST mint + header — add — id born before the send; mint-failure degrades to headerless.
- `slack-reply.sh` 409 branch — add — structured delivery-in-flight → exit 0 non-losing; unstructured → exit 1.
- `featureMarker: 'slack-reply-feature: delivery-id'` — change — migration parity for the template change.

## 1. Over-block

None. Idempotency only suppresses a re-send of an ALREADY-seen id (the point). A send with no delivery-id header is never gated. The unstructured-409 terminal path matches the deployed `else` fall-through (the script had no 409 branch before, so any 409 was terminal — the structured case is a strict rescue toward non-losing).

## 2. Under-block

The route id-ledger is IN-MEMORY (deployed-Telegram parity), so a restart clears it — a redrive after a restart at a ≥15-min backoff step past the content-dedup window can still double-post. That is the exact §2.4 durable-ledger gap, tracked as a follow-up increment (OQ-4). This increment closes the WITHIN-process first-attempt window (the mint-timing double-post) on Slack; the durable ledger closes the cross-restart window. slack-reply.sh has no queue tail yet (§2.6 full port is a later increment), so a recoverable Slack send failure still fails loudly rather than enqueueing — the honest, named residual (today's behavior for everything but 409/408).

## 3. Level-of-abstraction fit

Yes. Route-level idempotency belongs at the route (it owns the HTTP response); the delivery-id lifecycle belongs in the script that owns the send. Both mirror the Telegram precedent exactly.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — deterministic id-equality idempotency + a shell classifier keying on an exact structured code. Neither withholds a message on judgment; the tone gate remains the sole withholding authority.

## 5. Interactions

The route idempotency + the script pre-POST mint compose: the initial send records the id, a redrive of the same id is answered idempotent. The 408 (Arm B) and 409 (Arm C) branches converge on never-double-posting. No change to the success or genuine-error paths; existing slack reply-route + thread-route tests pass unchanged.

## 6. External surfaces

`/slack/reply` now honors `X-Instar-DeliveryId` (new idempotent-200 shape). New script marker line. No new route/config/env/CLI.

## 6b. Operator-surface quality

No operator-facing surface changes.

## 7. Multi-machine posture

Delivery-id state is machine-local (the in-memory LRU lives in the process that owns the socket). No cross-machine state.

## 8. Rollback cost

Low: revert the `/slack/reply` read/record block, the script edits, the featureMarker, and the two tests. A rolled-back binary ignores the header (deployed behavior).

## Conclusion

Closes the Slack first-attempt double-post window (pre-POST mint + route idempotency) and classifies the reservation-race 409 as non-losing on the Slack script, mirroring the Telegram lane, under the Testing Integrity Standard with real-route + real-script tests and Migration Parity for the template change.

## Second-pass review (if required)

Not required — route idempotency + script classifier mirroring an established deployed pattern, fail-toward-delivery, reversible, both surfaces tested.

## Evidence pointers

- `src/server/routes.ts` — `/slack/reply` X-Instar-DeliveryId read + record-after-success.
- `src/templates/scripts/slack-reply.sh` — pre-POST mint, header, 409 branch, feature marker.
- `src/core/PostUpdateMigrator.ts` — `slack-reply-feature: delivery-id` featureMarker.
- `tests/integration/slack-reply-delivery-id.test.ts`, `tests/unit/slack-reply-delivery-id-script.test.ts`.
- `docs/specs/slack-outbound-robustness.md` §2.4, §2.6, R8-M1 Arm C.

## Class-Closure Declaration (display-only mirror)

Class: delivery-id-covers-first-attempt (mint-timing double-post) on the Slack lane + the 409 member of the R8-M1 status class on the Slack script. The cross-restart window (durable id-ledger, §2.4) and the full slack-reply.sh queue tail (§2.6) remain as tracked follow-up increments.

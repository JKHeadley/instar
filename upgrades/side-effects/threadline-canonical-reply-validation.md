# Side-Effects Review — Threadline canonical reply validation

**Version / slug:** `threadline-canonical-reply-validation`
**Date:** `2026-07-19`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `/root/threadline_review` (independent reviewer subagent)

## Summary of the change

The `/threadline/relay-send` reply authorization gate now validates `inReplyTo` against the union of the legacy HMAC listener inbox and the modern hash-chained per-thread log, while requiring the durable reply-claim authority before either source can authorize. A dedicated helper contains the fail-closed policy; unit and behavioral production-route tests pin it. This closes `fb-63d7c1fb-50a`.

## Decision-point inventory

- `isAuthenticatedThreadlineInbound` — added authority helper — decides whether a reply pointer names a durable authenticated inbound on the claimed thread.
- `/threadline/relay-send` — modified — delegates its existing reply-authorization decision to the union helper.

## 1. Over-block

Valid messages absent from both evidence stores remain rejected. A modern entry with an invalid/unconfined thread id is rejected even if bytes exist, preserving traversal safety. A log read failure rejects unless the legacy store independently proves the pointer. Evidence also fails closed when `ListenerSessionManager`, the durable at-most-once claim authority, is unavailable.

## 2. Under-block

The new path accepts only `direction: inbound`; an outbound leg cannot authorize a reply. `ThreadLog` is populated through the authenticated inbound recording funnels. A local attacker able to rewrite the agent's state directory is outside the existing ThreadLog trust boundary; chain verification is an observability check rather than a per-send hot-path scan.

## 3. Level-of-abstraction fit

The helper sits at the reply authorization chokepoint and consumes the two existing canonical persistence authorities. It does not duplicate authentication or message recording. The migration union belongs here because the decision is specifically “does durable canonical evidence contain this inbound?”

## 4. Signal vs authority compliance

[docs/signal-vs-authority.md](../../docs/signal-vs-authority.md) applies. This gate has deterministic authority over an enumerable security invariant: exact thread id + exact message id + inbound direction in an authenticated canonical store. No semantic judgment or brittle content heuristic is involved.

## 4b. Judgment-point check

No competing-signals judgment. Store membership, direction, and thread confinement are exact invariants.

## 5. Interactions

The helper runs after the warm-worker current-inbound check and before the at-most-once reply claim. It broadens only the evidence source and explicitly couples authorization to availability of claim ownership. Legacy traffic remains byte-for-byte eligible. Modern E2E relay traffic now reaches the same claim gate. The production route test proves acceptance claims then releases after delivery, while an active claim returns 409 without delivery.

## 6. External surfaces

Valid spawned Threadline workers can reply to authenticated inbound messages persisted only in the modern log. Invalid replies still receive the same 400 error shape. No operator action, new endpoint, or external credential is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design under Threadline's single-holder model: both canonical stores belong to the receiving holder and the reply route runs there. Cross-machine relay ingestion writes the modern log before the worker replies. No user notice or URL is generated; durable reply claims remain on the holder.

## 8. Rollback cost

Pure code change. Revert and ship a patch; no schema, migration, or state cleanup is required. Rollback would restore the valid-reply rejection for modern-only inbounds.

## Conclusion

The missing standard was migration-consumer completeness: a new canonical authority must be adopted by every authorization consumer or exposed through an explicit compatibility union. The process gap was a wiring test that pinned the legacy implementation string rather than the semantic two-store contract. The helper and tests close both gaps. Pending required independent review because this touches a messaging authorization gate.

## Second-pass review

**Reviewer:** `/root/threadline_review`
**Independent read:** concur. The reviewer first blocked the change because modern evidence could authorize when the at-most-once claim authority was absent. After the correction, they independently inspected the diff and reran the focused suite (21/21): authorization now requires claim authority, modern-only evidence reaches claim and post-delivery release, and an active claim returns 409 with no delivery.

## Evidence pointers

- `tests/unit/threadline/ThreadlineReplyValidation.test.ts`
- `tests/integration/threadline-relay-send-priority.test.ts`
- `tests/integration/threadline-reap-recovery-wiring.test.ts`
- Feedback `fb-63d7c1fb-50a`

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: src/threadline/ThreadlineReplyValidation.ts#isAuthenticatedThreadlineInbound, howCaught: the live reply gate requires exact inbound evidence from either canonical generation and the regression suite reproduces a modern-only authenticated inbound }`.

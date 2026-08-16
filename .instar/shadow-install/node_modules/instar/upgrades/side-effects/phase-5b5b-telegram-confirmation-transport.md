# Side-effects review — Phase 5b.5.b TelegramConfirmationTransport

**Version / slug:** `phase-5b5b-telegram-confirmation-transport`
**Date:** `2026-05-16`
**Author:** Echo (instar-developing agent)
**Second-pass reviewer:** not required (push→pull bridge with per-topic waiter queue; full edge-case coverage in tests against a fake adapter)
**Driving spec:** `specs/provider-portability/10-suggest-and-confirm-ux.md`

## Summary of the change

Phase 5b.3 shipped `TelegramConfirmer` against a stub `ConfirmationTransport`. This slice implements the real transport that bridges the existing MessagingAdapter (push-based via `onMessage`) to the `ConfirmationTransport` contract (pull-based via `awaitReply`).

Design:
- **`TelegramConfirmationTransport`** in `src/providers/uxConfirm/TelegramConfirmationTransport.ts`.
- Takes a `MinimalMessagingAdapter` (slice of MessagingAdapter — send + onMessage only), a topic-extractor (`topicFromInbound`), and an outbound-shaper (`outboundForTopic`). Composable: same code drives Slack/iMessage/etc. when those land.
- Per-topic waiter queue: `awaitReply(topicId, timeoutMs)` registers a waiter; inbound message → look up waiter → resolve. On timeout, resolve with null.
- **Supersession**: a new `awaitReply` on a topic with a pending waiter resolves the prior waiter with null (the new confirmation has pre-empted it). Caller treats null as `default-no-reply` which is semantically correct.
- **Drop-on-no-waiter**: inbound messages without a registered waiter are silently dropped. Prevents stale replies from satisfying future confirmations.
- **Shutdown**: resolves every pending waiter with null so the event loop doesn't hold open.

Files touched:
- `src/providers/uxConfirm/TelegramConfirmationTransport.ts` — new, 175 LOC.
- `tests/unit/providers/uxConfirm/TelegramConfirmationTransport.test.ts` — new, 9 cases against a fake adapter.

## Decision-point inventory

- **Topic matching** — `add`. The transport decides "does THIS inbound message satisfy THAT awaitReply?" by comparing topic ids. Per signal-vs-authority, this is fine — the consequence of a mismatch is "the wait continues until timeout," not a wrong-confirmation.
- **Waiter supersession** — `add`. When two confirmations on the same topic overlap, the newer wins. This is the spec edge-case "Two Telegram messages arrive in quick succession" — implemented as a structural property of the queue rather than a downstream policy.
- **Drop-on-no-waiter** — `add`. Inbound messages that don't match any active waiter get discarded silently. Prevents the "user replied before we asked" race from satisfying a later prompt with a stale message.

## Signal vs authority

The transport is a signal-routing layer. It doesn't decide anything itself — it routes inbound text to whichever waiter is registered for the topic. The `TelegramConfirmer` above it is the authority that interprets the reply text.

## Over-block / under-block analysis

**Over-block:** A user who replies during a confirmation but to a different topic gets ignored (correctly). Their reply doesn't satisfy the wrong prompt.

**Under-block:** Drop-on-no-waiter means a user who replies BEFORE the prompt arrives (e.g., they were mid-typing) gets ignored. Their reply doesn't satisfy the LATER prompt. This is correct: a stale reply shouldn't fool the gate into thinking the user has consented.

A user who replies *just barely* before the supersession edge case — i.e., reply 1 arrives nanoseconds after the prior waiter was resolved by the new awaitReply — will have their reply dropped (the new waiter hasn't registered yet). This is theoretical; in practice the new awaitReply registers synchronously after resolving the prior. Worst case: the next reply still works.

## Level-of-abstraction fit

- The transport sits in `src/providers/uxConfirm/` alongside the confirmer. Pulls only the narrow MinimalMessagingAdapter slice — doesn't need the full MessagingAdapter contract.
- Provider-agnostic: name is "TelegramConfirmationTransport" because Phase 5b is Telegram-only per spec, but the same class trivially works for Slack/iMessage/etc. when those land — caller supplies a different topic-extractor and outbound-shaper.

## Interactions

- **`TelegramConfirmer` (Phase 5b.3)** — consumes a `ConfirmationTransport`. This class implements that interface. The confirmer's tests run against a stub; this transport adds the real implementation.
- **Existing `MessagingAdapter` implementations** — unchanged. The transport calls `onMessage(handler)` which is already part of the contract.
- **No existing source files modified** except the additive new ones.

## External surfaces

- New exports: `TelegramConfirmationTransport`, `TelegramConfirmationTransportOptions`, `MinimalMessagingAdapter`, `InboundMessage`.
- No new endpoint, no new CLI command, no new config field.

## Rollback cost

Trivial. `git revert` removes two new files. The TelegramConfirmer still works against any other `ConfirmationTransport` implementation (e.g., the stubs in its own tests).

## Tests / verification

- `npx tsc --noEmit` clean.
- `vitest tests/unit/providers/uxConfirm/TelegramConfirmationTransport.test.ts` — 9/9 pass.
- Coverage: send-delegation, inbound match-by-topic, ignore-different-topic, ignore-no-topic, timeout-returns-null, drop-when-no-waiter, supersession-same-topic (prior gets null), no-supersession-across-topics, shutdown-resolves-all.
- No real-API verification needed in this slice — bridging logic is deterministic against a fake adapter. The live Telegram round-trip happens at composition-root wiring (Phase 5b.5.c) and again at the E2E test slice (Tier 4.C).

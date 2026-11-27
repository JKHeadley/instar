# Side-Effects Review — a machine that cannot serve a message says so

**Version / slug:** `session-pool-no-silent-drop`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** codex-cli gpt-6-astra, 2 rounds; serious issues fixed, last round minor, fixed

## Summary of the change

`DeliverMessageHandler` refuses, as `stale-ownership`, a forwarded message this machine would otherwise ack and drop, unless it already received it, which answers `duplicate`. `src/core/DeliverMessageHandler.ts`, `src/commands/server.ts`, read-only `hasRemoteReceipt` in `src/core/PendingInboundStore.ts` and `src/core/QueueDrainLoop.ts`.

## Decision-point inventory

- Receive refusal — add — fails toward the sender keeping the message.

---

## 1. Over-block

A machine still starting, before its adapter exists, refuses and the sender handles the message; that beats dropping it.

## 2. Under-block

An old receiver still drops. A channel that fails after accepting is not seen here. Telegram placement can still choose such a peer, at the cost of one hop.

## 3. Level-of-abstraction fit

Right layer: the receiver is the only one that knows it cannot serve.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. Reads facts about this machine, not message content. Refusing hands the message back; nothing is blocked.

## 5. Interactions

The router's stale path re-places or reclaims. The wiring test holds `refusal` and `onAccepted`'s silent returns together. A dashboard start is exempt.

## 6. External surfaces

No new wire value. A log line on refusal.

## 7. Multi-machine posture

Machine-local check over machine-local receipts; existing ack value; an upgraded receiver protects any router.

## 8. Rollback cost

Revert the release. No state.

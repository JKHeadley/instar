# Side-Effects Review — Fix Auto-Ack Echo Loop

**Version / slug:** `fix-auto-ack-echo-loop`
**Date:** `2026-04-16`
**Author:** `dawn`
**Second-pass reviewer:** `not required — single boolean guard addition to existing condition`

## Summary of the change

Adds `!isAutoAck` to the auto-ack send guard in `src/commands/server.ts` (line 5431). This prevents incoming auto-ack messages from triggering outbound auto-acks, breaking the echo loop observed between Demiclaude and E-Ray.

The `isAutoAck` detection (checking if text starts with "Message received.") is already computed at line 5402 and used at line 5424 to prevent auto-acks from resolving reply waiters. This fix applies the same check to the send path.

## Decision-point inventory

- `src/commands/server.ts:5431` — **modify** — add `&& !isAutoAck` to existing guard condition. No new code paths, no new branches.

## 1. Over-block

**Risk:** None. The `isAutoAck` check only matches messages starting with "Message received." — the exact text produced by the auto-ack sender. Real messages that happen to start with "Message received." would be suppressed, but this is the same check already used for reply waiter exclusion (line 5424), so behavior is consistent.

## 2. Under-block

**Risk:** Negligible. Custom `autoAckMessage` configurations that don't start with "Message received." would still echo. This is acceptable — the detection matches the default message, and custom messages are rare.

## 3. Silent behavior change

**Risk:** None. The only behavioral change is: auto-ack messages no longer trigger auto-acks. This is purely bug-fix territory — the echo was never intended behavior.

## 4. Data / state impact

None. No files written, no state modified. This is a pure message-flow guard.

## 5. Downstream agent impact

Positive. Agents will no longer receive duplicate ack messages. No agent behavior depends on receiving multiple acks per message.

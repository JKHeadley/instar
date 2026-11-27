# Side-Effects Review — Echo Bugs reply recovery visibility

**Version / slug:** `echo-bugs-recovered-reply-history`  
**Date:** 2026-11-04  
**Author:** Echo  
**Second-pass reviewer:** independent review agent

## Summary of the change

Tier 1, 8 source/test files and about 80 changed lines; one review round and one commit/gate attempt planned. A recovered origin send now mirrors its Telegram receipt into topic history, using the issues chat and real thread to restore the internal topic id. A held session reply caused by a proved connect failure creates a deduplicated hub attention item. The advisory log explicitly marks preflight rows as delivery unconfirmed. The transport's connect error code is logged without credentials. This is built in a fresh worktree based on `JKHeadley/main`, remote `https://github.com/JKHeadley/instar.git`, package version 1.3.1646. Rollback is a revert; the durable origin outbox and retry authority remain unchanged.

## Decision-point inventory

- Origin recovery send gate: pass-through. The existing sealed outbox owns retries; this patch only observes a confirmed receipt.
- History mirror: add. Only a correlated Bot API acceptance from `sendMessage` produces a history row; adapter dedupe prevents a second row.
- Held session attention: add signal. The proved before-network connect failure creates an operator observation; it does not grant or deny send permission.
- Advisory API interpretation: modify presentation. `clean` means preflight only and is labeled `not-confirmed`.

## 1. Over-block

No block/allow surface; no legitimate message is rejected by this patch.

## 2. Under-block

A process crash after the origin store saves a recovered acceptance but before the callback writes history can still leave a log gap. Other hold reasons still rely on existing status and notices. An accepted Telegram receipt does not prove that a human read the message.

## 3. Level-of-abstraction fit

The origin transport confirms platform acceptance, and the Telegram adapter owns topic history. The callback joins those layers only after the existing origin authority has accepted the receipt. The attention observation uses the existing hub item system rather than another sender.

## 4. Signal vs authority compliance

[Signal vs authority](../../docs/signal-vs-authority.md): no new blocking authority. The connect failure is a transport proof and only feeds logging and attention. Retry permission remains with the outbox.

## 4b. Judgment-point check

No static heuristic at a competing-signals decision point. The log mirror requires a concrete receipt, and the alert requires the existing proved-unsent failure class.

## 5. Interactions

Normal sends still log in `sendToTopic`; recovered sends bypass it and use this callback. Adapter message-id dedupe handles a callback repeated by a recovery race. The callback runs after durable outcome recording and cannot trigger a resend. Attention uses a stable per-operation id, so repeated holds of the same reply coalesce. A confirmed recovered receipt closes exactly that operation's item, including when attention lifecycle automation is disabled.

## 6. External surfaces

The advisory endpoint adds `stage` and `deliveryStatus`; existing fields remain. Recovered sends appear in topic history and search. The operator hub shows delayed session replies while Telegram connect attempts fail. No new Bot API request is made.

## 7. Multi-machine posture

Origin operations remain machine-local to their execution owner and are recovered there. A holder logs recovered receipts into its topic history. The hub attention is created on that holder. Forward-to-holder behavior on a standby is unchanged and owned by the separate topic 10000001549 work.

## 8. Rollback cost

Revert the code and restart the server. Already-written message history rows remain true receipt records; existing dedupe prevents duplicates. No migration is required.

## Evidence

On the Mac Studio, operation `4a9ca1dd-56f3-4294-8cab-7fb7d7f80f47` was accepted on a recovery attempt at 05:44:45 UTC with Telegram message 1550, but topic 10000001534 history lacked that row. Operation `1206bc11-c6b0-441a-8d3f-619fcb82b45b` was still admitted after a proved connect failure; its outbox scheduled a retry. The new regression test failed with `logRecoveredOriginMessage is not a function` before the adapter change and passes afterward. The advisory E2E test passes with the new status fields.

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: n/a`. The new notification is a one-shot response to one existing send hold, keyed by that operation id. It installs no timer, retry, or self-triggered loop; the existing origin outbox retains all retry authority. No agent-authored-artifact defect.

## Second-pass review

The independent reviewer confirmed that the callback requires a Telegram receipt and existing adapter dedupe prevents a second history row. Concern raised: the new attention item could remain open after delivery. The callback now closes an operation-scoped item after receipt-confirmed recovery, with a fallback when lifecycle automation is disabled. The reviewer also noted that a recovery-path callback test would strengthen the adapter-only test; the targeted integration and E2E checks cover the added history and advisory behavior.

**Recheck:** The reviewer concurs with the revised fix. Each pending operation has its own attention item, and confirmed recovery closes it with or without attention lifecycle automation. The documented crash window remains.

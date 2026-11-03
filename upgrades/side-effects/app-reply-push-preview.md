# Side-Effects Review — reply notification preview

**Version / slug:** `app-reply-push-preview`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Chat-media spec §4.11 (increment 4): the iPhone notification extension fetches a short preview of an agent reply from the agent.

1. `src/core/appMediaTypes.ts`: `pushPreviewBody(attachments, text)`.
2. `src/core/MobilePush.ts`: `PushTrigger.messageId`; `onAppReply` sets it; the reply payload's `instar` block carries `messageId` and `machine` (a plain-id pattern check drops anything else). The alert body stays "New reply".
3. `src/server/mobilePairingRoutes.ts`: the notification read token's allowlist grows from exactly `GET /mobile/attention/<id>` to also `GET /mobile/chat/app/<uuid>/preview/<id>`; `/mobile/push/notify` carries a valid `messageId` between machines.
4. `src/server/mobileConversationRoutes.ts`: the preview route (device, device-notify or the agent token; agent replies only; 404 otherwise).

## Decision-point inventory

- Notification read token allowlist — modify — invariant: a fixed list of two exact read paths. Deterministic by design (authentication).

## 1. Over-block

A reply not yet replicated to the machine the phone asks gets 404; the phone keeps "New reply" (spec-accepted). The machine in the payload is the one that sent the push, which holds the reply.

## 2. Under-block

The read token now reveals the first 100 characters of an agent reply to anything holding that token. It is stored only in the phone's app group, for the notification extension; it is the same token that already reads attention titles, active devices only, rate-limited per device. It opens no history, no send and no other conversation route (tested).

## 3. Level-of-abstraction fit

The route sits with the other app conversation routes and reads the existing index (`getMessageEvent`); the phrase builder sits next to the existing `mediaPreview`.

## 4. Signal vs authority compliance

No decision about agent behaviour; an authentication allowlist is extended by one exact path. Reference: docs/signal-vs-authority.md.

## 5. Interactions

Dedupe keys are unchanged (`app-reply:<messageId>`), so a peer echo still dedupes. Older phones ignore the new payload fields.

## 6. External surfaces

APNs payload gains a message id and machine id (opaque identifiers, no content). One new device-readable route.

## 7. Multi-machine posture

Proxied-by-owner: the payload names the machine that sent the push, which holds the reply; the phone asks that machine (spec §4.11). No new replicated state.

## 8. Rollback cost

Revert. Phones fall back to "New reply". No state.

## Second-pass review

Independent reviewer — Concur with the review. The read token reaches only the two anchored GET paths; a messageId from another conversation is refused (lookup is by the conversation's own key); operator messages and deleted conversations 404; messageId is pattern-checked on payload build and on peer notify. Its one note (the payload and notify checks allowed capitals the route refuses) is fixed: all three use the same lowercase pattern.

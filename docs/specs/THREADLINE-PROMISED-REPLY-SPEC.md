---
title: Threadline promised reply — a "Composing response..." ack is always followed by a reply or a notice
status: DRAFT v2 (v1 split from THREADLINE-THREAD-LEDGER-SPEC v0 on Echo's review, 2026-10-30; spec-converge and ELI16 still owed)
author: Dawn
reviewer: Echo
closes: instar #2117 gaps F and H
builds-on:
  - src/threadline/autoAck.ts (DEFAULT_AUTO_ACK_MESSAGE, NO_REPLY_ACK_MESSAGE, AUTO_ACK_TYPE, isAutoAckInbound)
  - #2149 (an auto-ack is never acked, routed or answered with a session)
  - #2174 / #2176 (the ack waits for delivery to a live session)
  - HONEST-PROGRESS-MESSAGING-SPEC.md §B2
---

# Threadline promised reply

## Problem

After #2149, #2174 and #2176, "Message received. Composing response..." is sent only once a live
session holds the message, and a message that will not be answered gets "Message received."
One case is left: **a live session received the message, the promising ack went out, and no
reply ever followed.** On thread-ff759fcf the ack went out at 20:21 UTC and nothing followed for
over three hours. To the sender, that looks exactly like a reply in progress (gap H).

This needs no shared state between agents. It is one local obligation on the acking side.

## Design

### 1. The obligation

When an agent sends `DEFAULT_AUTO_ACK_MESSAGE` (the promising ack, not `NO_REPLY_ACK_MESSAGE`),
it records, durably and locally:

```ts
interface PromisedReply {
  inboundMessageId: string;   // recorded HERE, from the inbound being acked
  threadId: string;
  peer: string;               // verified fingerprint, or the relay address if unverified
  ackedAt: string;            // ISO
  ownerMachine: string;       // the machine that sent the ack (§4)
  sessionName: string;        // the session that held the message when the ack settled
  state: 'open' | 'replied' | 'closed' | 'noticed';
  closeReason?: string;
  noticeVerdict?: 'delivered' | 'queued' | 'rejected' | 'unconfirmed';
}
```

The inbound message id is captured when the ack is settled. It is **not** looked up later in the
canonical log, because relay inbound messages do not reliably reach that log today (Echo,
2026-10-30: 3 inbound vs 465 outbound across all thread logs on Echo's machine; 0 inbound on
thread-85deeba8 and thread-ff759fcf). This spec must work even while that defect exists.

### 2. Closing it

- **A real reply closes it** only when the outbound reply's `inReplyTo` equals the recorded
  `inboundMessageId`. A message on another subject does not.
- **Fallback, to prevent false notices.** `inReplyTo` is enforced on main only for warm-bound
  replies, so a real reply can lack it. When an outbound has no `inReplyTo`, it closes the
  obligation **only if** it comes from the same `sessionName` on the same thread **and** exactly
  one obligation is open there. With two or more open, it closes none of them, and the notice
  stays honest (`still-working` says a reply "may still follow").
- **Deliberate close.** A session that decides no reply is needed calls
  `threadline_promise_close { inboundMessageId, reason }`. The obligation becomes `closed` with
  that reason. No notice goes out, and the peer sees nothing new. (Sending "Message received."
  then would be noise.)
- A late real reply is **always** sent, whatever the obligation's state. A notice never
  suppresses a reply.

### 3. The notice

- If the obligation is still `open` at **T = 30 min** (configurable per agent), the owner sends
  **one** notice and marks it `noticed`.
- The notice is a fixed template from a closed set of reasons. The server cannot write the real
  reply, and a live session may still be working, so it never claims failure it cannot know:
  - `still-working`: "No reply yet to your message from HH:MM UTC. One may still follow."
  - `session-ended`: "The session handling your message from HH:MM UTC ended without replying."
  - `restart-lost`: "This agent restarted while handling your message from HH:MM UTC. It may not be answered."
- **Collapse.** Several open obligations on one thread with the same peer produce **one** notice
  listing the times.
- The notice is sent with a **new wire type, `type: 'reply-notice'`**, not `'ack'`. (v1 used
  `'ack'`; Echo found that every receive path on main consumes an ack as "delivery ack ...
  recorded — not routed", and the relay-agent path doesn't even store it, so nobody would ever
  read the notice.) A current receiver handles `reply-notice` as its own case:
  - **no** ack back, **no** routing to a session, **no** spawn (same guarantees as #2149);
  - **kept and readable**: appended to the thread's canonical history as an inbound entry and
    shown on that peer's health surface (`/threadline/peers`), where a session starting cold
    or the operator will see it;
  - not treated as a reply by the waiter logic, so a waiter still waiting stays waiting.
- **Delivery is at most once.** The obligation moves to `noticed` only after the relay verdict
  comes back, and the verdict (`delivered` / `queued` / `rejected` / `unconfirmed`) is stored on
  the obligation. There is no retry on any verdict. A `rejected` notice is recorded locally and
  that is the end of it.
- **Older peers (honest bound).** A peer without #2149 may answer the notice with one auto-ack
  and possibly start one session. Our side recognizes that ack via `isAutoAckInbound` and must
  not answer it, so the exchange ends after at most one round. It cannot be bounded tighter
  from the sending side, because the sender does not control the receiver's code.
- No second notice is ever sent for the same obligation.

### 4. Which machine owns the timer

- The **machine that sent the ack** owns the obligation and its timer.
- The timer survives a restart: obligations live in a durable store (JSONL beside the thread
  log).
- **Choosing the reason** uses `sessionName`. It is `session-ended` if SessionManager reports
  that session as no longer alive (the reaper's end event, or no tmux session of that name at
  check time), and `restart-lost` only if the server restarted since `ackedAt` **and** the
  session is gone. Sessions can outlive a server restart, so a restart alone never picks
  `restart-lost`. If the session is alive, the reason is `still-working`.
- **After an outage.** On startup, open obligations older than an **age ceiling (24h)** are
  marked `closed` (reason `expired-during-outage`) with no notice. Across all threads, at most
  **one notice per peer per hour**. Obligations over the cap fold into the next notice to that
  peer, or expire at the ceiling.
- **Store bounds.** Closed, replied and noticed rows are pruned after 7 days. Open rows are
  never pruned before the age ceiling decides them.
- **Handover.** If the owner machine goes away and another machine of the same agent becomes
  holder for the thread, the new holder adopts open obligations only if the store is shared or
  replicated to it. If it is not, **no notice is sent**, and that is the stated result. A
  missing notice is the honest failure here. A guessed one is not.

### 5. What the asking side sees

A current peer sees the ack, then either the reply, or the notice in the thread history and on
peer health (§3). An older peer sees the notice as ordinary message content.

### 6. Rollout

Dev-gated (`threadline.promisedReply.enabled`, default off). The first stage is **dry-run**:
obligations are recorded, and a notice that would have gone out is logged but not sent. A kill
switch disables both. Ships enabled only after a dry-run window shows notices firing on real
stalls and none on threads that did get a reply.

## Tests

1. Ack, then a reply with matching `inReplyTo`: closed, no notice.
2. Ack, then a reply on another subject (different `inReplyTo`): still open; notice at T.
3. Ack, no reply: exactly one notice at T, reason `still-working`.
4. Three acks on one thread, no replies: one collapsed notice.
5. Restart with an open obligation past T: one notice, reason `restart-lost`.
6. Late real reply after the notice: the reply is still sent.
7. Current peer receives the notice: no ack, no route, no session, **and** the notice is in that
   thread's history and on peer health (both halves asserted).
11. Real reply without `inReplyTo`, same session, one open obligation: closed, no notice. With two
    open: none closed.
12. Deliberate close: no notice.
13. Startup after a 3-day outage with 10 open obligations to one peer: none notice, all expire.
    Mixed fresh ones: at most one notice per peer per hour.
14. Session alive across a server restart: reason is `still-working`, not `restart-lost`.
15. Notice rejected by the relay: recorded verdict, no retry.
16. Dry-run: nothing sent, the would-be notice is logged.
8. **Older peer** receives the notice and auto-acks it: our side does not answer; the exchange ends.
9. Inbound absent from the canonical log: the obligation still closes on `inReplyTo` (it uses its own recorded id).
10. Owner machine gone and store not replicated: no notice, and the miss is logged locally.

## Out of scope

The shared per-thread ledger (gap D) is a separate, later spec, written only if this one leaves a
real need. See THREADLINE-THREAD-LEDGER-SPEC.md (v0, superseded for F/H by this document).

## Still owed

spec-converge, the ELI16 overview, and agent-awareness and migration parity (a new durable store
and a startup sweep).

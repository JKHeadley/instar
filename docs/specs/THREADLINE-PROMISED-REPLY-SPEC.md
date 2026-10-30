---
title: Threadline promised reply — a "Composing response..." ack is always followed by a reply or a notice
status: DRAFT v1 (split from THREADLINE-THREAD-LEDGER-SPEC v0 on Echo's review, 2026-10-30; spec-converge and ELI16 still owed)
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
  state: 'open' | 'replied' | 'noticed';
}
```

The inbound message id is captured when the ack is settled. It is **not** looked up later in the
canonical log, because relay inbound messages do not reliably reach that log today (Echo,
2026-10-30: 3 inbound vs 465 outbound across all thread logs on Echo's machine; 0 inbound on
thread-85deeba8 and thread-ff759fcf). This spec must work even while that defect exists.

### 2. Closing it

- **A real reply closes it** only when the outbound reply's `inReplyTo` equals the recorded
  `inboundMessageId`. A message on another subject does not.
- An outbound reply with no `inReplyTo` does not close it. (Every send path that answers a
  specific inbound must set `inReplyTo`. Where one doesn't today, that is a bug this spec
  surfaces.)
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
- The notice is sent with `type: 'ack'` (`AUTO_ACK_TYPE`), so a current peer recognizes it via
  `isAutoAckInbound` and #2149 holds: no ack back, no routing, no session.
- **Older peers (honest bound).** A peer without #2149 may answer the notice with one auto-ack
  and possibly start one session. Our side recognizes that ack via `isAutoAckInbound` and must
  not answer it, so the exchange ends after at most one round. It cannot be bounded tighter
  from the sending side, because the sender does not control the receiver's code.
- No second notice is ever sent for the same obligation.

### 4. Which machine owns the timer

- The **machine that sent the ack** owns the obligation and its timer.
- The timer survives a restart: obligations live in a durable store (JSONL beside the thread
  log), and on startup every `open` obligation past T gets its notice (reason `restart-lost` if
  the session that held the message is gone).
- **Handover.** If the owner machine goes away and another machine of the same agent becomes
  holder for the thread, the new holder adopts open obligations only if the store is shared or
  replicated to it. If it is not, **no notice is sent**, and that is the stated result. A
  missing notice is the honest failure here. A guessed one is not.

### 5. What the sender shows

Nothing new is needed on the sending (asking) side: it sees the ack, then the reply or the notice.

## Tests

1. Ack, then a reply with matching `inReplyTo`: closed, no notice.
2. Ack, then a reply on another subject (different `inReplyTo`): still open; notice at T.
3. Ack, no reply: exactly one notice at T, reason `still-working`.
4. Three acks on one thread, no replies: one collapsed notice.
5. Restart with an open obligation past T: one notice, reason `restart-lost`.
6. Late real reply after the notice: the reply is still sent.
7. Current peer receives the notice: no ack, no route, no session (#2149).
8. **Older peer** receives the notice and auto-acks it: our side does not answer; the exchange ends.
9. Inbound absent from the canonical log: the obligation still closes on `inReplyTo` (it uses its own recorded id).
10. Owner machine gone and store not replicated: no notice, and the miss is logged locally.

## Out of scope

The shared per-thread ledger (gap D) is a separate, later spec, written only if this one leaves a
real need. See THREADLINE-THREAD-LEDGER-SPEC.md (v0, superseded for F/H by this document).

## Still owed

spec-converge, the ELI16 overview, and agent-awareness and migration parity (a new durable store
and a startup sweep).

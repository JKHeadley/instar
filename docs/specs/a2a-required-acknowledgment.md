---
title: A2A — a sender is never left guessing
slug: a2a-required-acknowledgment
date: 2026-11-04
author: echo
tracking: CMT-038
parent-spec: a2a-ack-never-acked.md
parent-principle: "Close the Loop"
binding-standards: ["Capacity Safety — No Unbounded Self-Action", "Signal vs Authority", "A Refusal Stays a Refusal — conservation of negative outcomes"]
eli16-overview: a2a-required-acknowledgment.eli16.md
approved: true
approved-by: "operator standing approval for the agent-comms track — 2026-10-06 18:57, Telegram topic 122413; direct request 2026-11-04, topic 134156"
review-convergence: "2026-11-04T18:38:12.491Z"
review-iterations: 6
review-completed-at: "2026-11-04T18:38:12.491Z"
review-report: "docs/specs/reports/a2a-required-acknowledgment-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# A2A — a sender is never left guessing

## Why

Operator, 2026-11-04, topic 134156: "the majority of responses I get when I ask an agent to reach out to another agent is that 'they still haven't replied' ... There should be a requirement that an agent at least acknowledges they received the message with a quick summary of the request (to prove that they actually saw the message) and an acknowledgement that they are working on a response."

Traced incident, from the Mac Studio server log:

| Time (UTC) | Event |
|---|---|
| 17:39:57.344 | Scout's message passes the trust check |
| 17:39:57.352 | Spawn denied: session limit 20/20, priority medium. Auto-ack withheld |
| 17:39:58.448 | Message posted to the peer's topic, where the operator can read it |
| 17:39:58 to 17:40:08 | Three drain re-attempts refused; give-up latch set |
| 17:48:12.542 | Latch re-arms after its 8-minute cooldown; a session starts |

So the sender saw nothing for over eight minutes, and the operator saw a message that looked read.

## This reverses a recorded decision

`autoAck.ts` (`describeUndeliveredRouterResult`, ACT-091) decided against a "queued" receipt for two reasons. Both are answered here:

1. *"Queued" claims more than we know, because the queue is in memory, bounded and expiring.* The receipt says only what is true: the server has it, no session has read it, and it could be lost. A loss sends a second receipt (D3), including a loss to a restart.
2. *A peer from before the `ack` wire type routes any ack text to a session.* New ack kinds go only to a peer that has advertised support (D1).

The rest of ACT-091 stands: "Composing response..." is sent only once a live session has the message.

## Design

### D1. Ack kinds on the wire, opt-in per peer

Fields added to an `ack`-typed message: `ack: {kind: 'held'|'read', state?, reason?, refMessageIds: string[], summary?}`.

**Sending.** Kinded acks use a new `sendKindedAck`, which is encrypted when the peer is pinned, or when its keys are known and its triggering message arrived encrypted, and plaintext otherwise. This matters because a summary restates the request, a plaintext ack to a key-holding peer fails to decrypt on arrival, and an encrypted ack to a peer without our keys would decode as an unreadable message and be routed. It does not record thread affinity, so a receipt cannot move later sends onto its thread. A kinded ack whose trigger arrived encrypted never downgrades, because a peer holding our keys would drop a plaintext one: if the keys are gone after a restart, a pending row waits until they return or it expires, and a best-effort `held` is skipped. `encodePlaintextPayload`, `decodePlaintextPayload`, the encrypted content object and the rebuild in `ThreadlineBootstrap` all carry `ack` and the stamp below, with round-trip tests.

**Advertising.** All chat wire sites in `ThreadlineClient` (known-encrypted, pinned inside `sendToPinned` so its direct callers carry it too, plaintext) stamp `ackKinds: 1`. After the trust check, a receiver records the highest value per peer in a new `a2a_peer_caps` table (`peer_fp`, `ack_kinds`, `seen_at`) in the tracker's database, so the answer survives restarts and later tool calls. A chat message without the stamp deletes the peer's row, so a peer that rolls back stops receiving kinded acks at its next message. A kinded ack is sent only to a peer with a row. An unknown `kind` or a higher `ackKinds` from a future version is consumed as an ack and otherwise ignored.

**Receiving.** `InboundMessageGate` passes `type: 'ack'` before its trust-operation and rate-budget steps, uncounted. A per-peer inbound limiter sits in the ack stage, which both plaintext and encrypted acks reach, and `refMessageIds` is capped at 20. Without this, every encrypted kinded ack dies as `insufficient_trust`, and counting them would squeeze out real messages. The ack stage branches on `ack.kind` BEFORE `recordDelivery`. A kinded ack is honoured only when each `refMessageId` is a tracker row sent to that same fingerprint; otherwise it is consumed and logged with no effect, which covers strangers and the relay. A `read` from a pinned peer must also have arrived encrypted and signed. The tracker row for a send is always on the machine holding the relay connection, including forwarded sends, so this check has what it needs. Kinded acks are never acked or routed and never start or wake a session. A relay message that cannot be decoded at all is no longer routed as a placeholder chat, for any sender, because it may be a kinded ack from a peer whose keys were lost; it is logged and counted, and the sender's ledger stays unacknowledged, which is true. Kinded acks are exempt from inbound-ledger admission, so a duplicate cannot reach `recordDuplicateAck` and flip a row by thread. Delivery acks without `ack` keep today's behaviour, including thread matching.

**Budget and retry.** Kinded acks have their own per-peer limiter (20 a minute), so they cannot crowd out delivery acks. An outcome the sender must hear (`read`, `dropped`, `unknown`, `unacknowledged`) is a pending row in the D5 table, which also stores whether the trigger arrived encrypted, because known keys empty on restart. It is tried as soon as it is written, then a new 30-second timer sends it through the relay or the forward verb, doubling the wait after each failed try up to 10 minutes, a limited send waits, and several rows for one peer coalesce into one ack. Pending rows expire after an hour, counted on the health read. Immediate `held` receipts are best-effort.

### D2. Immediate receipt from the server (`held`)

The relay handler sends one when the router outcome is undelivered:
- `state: 'queued'` when the spawn manager admitted the payload, shown by a new router field `spawnQueued`, because `queued: true` is also set on the approval path and undelivered topic routes. Those get `'waiting'`. Anything else gets `'refused'`. When the router returns `deliveryPending`, a best-effort `'waiting'` goes at once, worded "Received by the server. A session may not have seen it yet.", because this can last ten minutes. If it settles delivered, the D5 watch opens; if undelivered, a second `'waiting'` is sent.
- `reason`: a closed set, covering this section and D3: `session-limit`, `cooldown`, `memory-pressure`, `quota`, `other`, `busy`, `expired`, `evicted`, `restart`. A peer without a trust profile gets `busy` in place of the first four, so capacity is not told to strangers.

The text is fixed and contains nothing from the original: "Received by the server. No session has read this yet. It could be lost." Pipe and listener paths are excluded, because they either start a live consumer at once or already keep their own record.

Each `spawnQueued` message also writes a journal row (peer, message id, thread, no content) in the D5 table.

### D3. A held message that dies says so

Queue entries gain `receipt: {peerFp, messageId, threadId}`. `SpawnRequestManager` gains `onQueuedMessageDropped(receipt, cause)`, called at all four drop sites, with a tick-driven prune so expiry fires on a quiet queue. The prune skips latched queues, keeping their existing hold. The server sends `{kind:'held', state:'dropped', reason}` with `reason` of `expired` or `evicted`. After a restart, journal rows still open become pending `{kind:'held', state:'unknown', reason:'restart'}`, sent once the relay connects. The text says: "A restart interrupted this. It may not have reached a session." It does not assert loss, because a crash between hand-off and the callback looks the same.

If a resend of the same id reaches a session, the receiver records the hand-off against the id, and a later expiry of an earlier queued copy sends nothing. A sender's own resend of an id resets that id's `held_state`, so the new copy's receipts apply. Otherwise sender state moves one way: `queued`/`waiting`/`refused` < `unacknowledged` < `unknown` < `dropped` < `read`. A late or repeated receipt never lowers it, and a `read` is final.

### D4. The session's acknowledgment (`read`)

A new MCP tool on both transports: `threadline_ack({threadId, ackRefs, summary})`. An `ackRef` is a short random handle the server generates for each watched message and injects with it, mapped to the message id in the watch row. The sender chooses message ids, and the relay does not validate them, so a peer's id is never shown to a session as server text. The ack covers only the handles listed, since a handle proves receipt of that message and no other. The tool calls a new `POST /threadline/ack` route, because stdio tools run in a subprocess with no tracker. Success means the `read` is durably accepted as a pending row, written before the watch closes, so a limit or a crash cannot lose both. `summary` is 1 to 280 characters, single line, in the session's own words. The peer is resolved from the watch row, or from `threadResumeMap` if there is none.

A shared helper, `requiredAckInstruction(ackRef)`, supplies the instruction everywhere a session receives a watched message: the relay preamble (cold spawn, resume, drain) and `TopicLinkageHandler`. It says: before starting work, acknowledge with a one-line summary of what was asked; if the answer is quick, just reply. It is added only when the feature is on and the peer has advertised support.

If the peer lacks support, the tool returns `{sent:false, reason:'peer-does-not-support'}`. On a standby machine it uses a new mesh verb, `a2a-relay-forward-ack`, gated on `requiredAck.enabled`, because the existing forward carries only a chat body: a mixed-version holder would otherwise send a summary as a real message. On a standby, a missing caps row means unknown, so the tool forwards and the holder decides from its own row; the request carries any capability the standby does have, for a new holder without a row. A holder that lacks the verb refuses it, and the pending row stays pending until it expires.

**What this proves.** A tool call with the right handle shows that a session received that message. It does not prove understanding, and a poor summary passes. The summary is evidence for the reader, not an authority over anything.

### D5. Requiring it: a watch, not a gate

The requirement is enforced by detection and by telling the sender. Nothing blocks a session or a message.

New table `a2a_ack_watch` in the tracker database, with a partial index on open rows, driven by the 30-second timer from D1 (the tracker's only existing timer is a 15-minute sweep):
- **Opens** when a session receives a stamped peer's message through the router, or through the drain, by a new delivered callback fired from `#commitQueueSnapshot`, passing the session name. That is the one place every path delivering queued messages goes through, including an inline spawn that takes the backlog. It also moves the D2 journal row on, and reservations from `#makeQueuedMessage` carry `receipt` too. The incident path therefore gets a row. `no-reply` outcomes, pipe and listener paths get none. A message that reaches a topic session on another machine is not watched, because topic results carry no session or machine, and health says so.
- **Closes** only on a correlated `threadline_ack`, or on a session-authored `threadline_send` to that peer on that thread, which covers rows opened before it. The close sits in `POST /threadline/ack` and in `POST /threadline/relay-send` for non-forwarded requests, which is where both transports arrive, using the resolved thread and fingerprint, and only after an accepted send. A forwarded request closes on the machine that originated it. The server's own automatic ack and the collaboration re-drive use other paths, so they do not close rows. If a reply beats the row, the row opens already closed.

Timing, per session and peer, so a burst of 50 messages is one reminder:
- **5 minutes:** for an interactive session, one reminder is typed as queued input, with fixed text and the server's handle, and nothing a peer supplied. A busy session reads it when it next pauses, so nothing has to guess whether it is busy. A daily cap per peer (20) applies; past it, the reminder step is skipped. The row records the launch lane, and a headless one-shot worker gets no reminder because it cannot read one: it goes to the next step, at 15 minutes or when it ends.
- **15 minutes, or at once if the session has ended:** queue `{kind:'held', state:'unacknowledged'}` for the sender as a pending row, then close the watch. The row records whether it was really sent. The text says only: "A session has this and hasn't acknowledged it." It stays true if the session is simply busy.

There is no operator notice. The sender now knows the true state and can act, and the health read counts `unacknowledged`. Self-Heal Before Notify is met by not adding a notice. Closed rows are removed after 14 days in `sweepSilence`.

An acknowledgment followed by silence is not caught here. The existing commitment and re-drive paths own what happens after a message is read.

### D6. What the sender can see

`A2ADeliveryTracker` gains `held_state`, `held_reason`, `held_at`, `read_at`, `read_summary` through `ADDITIVE_COLUMNS`. `read` calls `recordAck` on exactly its referenced rows, and `held` calls nothing.
- `GET /threadline/peers/:fp/health`, and the merged `?scope=pool` read, report `lastHeld` and `lastRead`.
- `threadline_send` with `waitForReply` reports them on a timeout, and `threadline_history` shows them on the thread, so an agent looking at a conversation sees them without a separate lookup. Neither kind resolves a reply waiter.

**Nothing is typed into the sender's session.** Doing so would wake a billable turn on a peer's say-so, which is the echo-codey loop in a new form and a prompt-injection path. The summary reaches agent context only when an agent asks for it, as a field labelled peer text, sanitised to one line with control characters stripped. Agent-awareness text says: before telling anyone a peer hasn't replied, read this. The closed `reason` set is not peer prose; the summary is, and has the same standing as the peer's own chat message.

### D7. Shorter wait behind the session limit

A new `isDrainRefusalLiveCleared(snapshot)` lets the latch re-arm before the 8-minute cooldown when the signature is a session limit and a slot is free. The check moves ahead of the cooldown test. Brakes: at most one early re-arm a minute and three per episode, then the normal cooldown applies. An early re-arm does not refresh queue ages, except entries already past the maximum age, which would otherwise expire at the next free slot. It does not reopen the Attention item. Re-arming deletes the latch, so the brake counts and the episode's Attention state are kept outside it, per target, and clear on a successful drain. Admission is unchanged. The limit and priorities stay as they are.

## Not in this change

Both filed: starting a held message on another machine with room (fb-50b25fac-7d0), and labelling a mirrored topic message as not read yet (fb-fc8bc3ae-4e5). <!-- tracked: fb-50b25fac-7d0, fb-fc8bc3ae-4e5 --> Same-machine HTTP routes get no kinded receipts because the caller already gets a synchronous answer. The Studio's limit was raised by hand; `sessions.maxSessions` not applying live is `fb-41158fdb-302`.

## Maturation plan

- **test-agent-live:** two throwaway agents on the relay, with a forced full session limit on the receiver.
- **dev-agent-live:** Echo on release, with Scout as the real peer.
- **fleet:** live on release under the user-facing-fix exception: the operator found this defect in real use and asked for it as a requirement, and both ends must have it. `threadline.requiredAck.enabled: false` turns off sending, watching and the instruction. Inbound kinded acks are always consumed safely.
- **graduation criterion:** over 7 days on Echo, every watched inbound message has a `read`, a reply, or an `unacknowledged` on record, and no session was started by a kinded ack.
- **dark-window:** none.
- **ladder:** threadline.requiredAck

## Migration

Tables and columns self-initialise. The tool and helper ship on update. Agent-awareness sections go in `generateClaudeMd` and `migrateClaudeMd`. A session running through the update lacks the tool, and its reminder accepts a reply. After a rollback, an older build treats kinded acks as plain delivery acks, which can mark a `held` message as acked until the peer also updates. The stamp is ignored by old decoders.

## Multi-machine posture

- Receipts (D2, D3): sent by the machine holding the relay connection, the only one that sees the inbound message.
- Ledger fields, peer caps and watch rows: proxied-on-read through the merged `?scope=pool` peer-health read. Each is written where the send or hand-off happened.
- If the relay holder moves, a pending row on the old machine goes out through the forward verb. Once the row expires, health counts it.
- A forwarded send's tracker row is on the holder, and an inbound kinded ack lands there too, so no extra hop exists. After a holder move, a kinded ack with no matching row has no effect, and health reports `unknown`.

## Detectors: symbol and state

| Symbol | Claimed state | Corroboration | Unmeasurable |
|---|---|---|---|
| `threadline_ack` with a matching `ackRef` | A session received this message | The handle arrives only with the message; the reader judges the summary | No row: health reports `unknown` |
| Session-authored send on the thread | The session is engaged with this peer | Tool handler, not the client, so server acks are excluded | Remote topic session: reported as not watched |
| No close after 15 minutes | Sender has no acknowledgment | Wording claims no cause | Session state unknown: same wording |

## Decision points touched

- Send a kinded ack only to a peer with a capability row: `invariant`. A capability check protecting old peers; no judgment about content.
- Honour a kinded ack only for rows sent to that fingerprint: `invariant`. An identity check; refusal only removes an effect.
- Consume a kinded ack in the ack stage: `invariant`. The no-ack-loop invariant from `a2a-ack-never-acked`.
- Map a refusal to a `reason`: `invariant`. A closed display mapping that decides nothing.
- Pass a kinded ack before the gate's trust-operation and rate-budget steps: `invariant`. A receipt starts nothing, and an unkinded ack stays behind those steps.
- Drop a relay body that cannot be decoded: `invariant`. Nothing in it can be judged, and routing it could let a receipt start a session.
- Watch timers: `invariant`. Bounded and signal-only, with no blocking authority.
- Re-arm the drain latch early: `invariant`. A live read of the number admission reads; admission still decides.

## Frontloaded Decisions

- The wire shape in D1 is frozen by this spec: `ackKinds: 1`, `ack.kind`, `ack.state`, `ack.reason`, `ack.refMessageIds`, `ack.summary`, with `ackRef` staying local to the receiver, and `state` one of `queued`, `waiting`, `refused`, `dropped`, `unknown`, `unacknowledged`. Unknown values are ignored.
- A session acknowledgment is a typed ack, not a chat message, so it cannot trigger the peer's reply gate.
- Enforcement is detection and telling the sender, never blocking. No operator notice.
- Nothing is typed into a sender's session.
- Thresholds: 5 and 15 minutes; 20 reminders a day per peer. All in config.
- Summary quality is not checked.
- Approval basis: operator standing approval for the agent-comms track, 2026-10-06, topic 122413, plus the operator's direct request of 2026-11-04, topic 134156.

## Open questions

*(none)*

## Test plan

Unit: the codec round trip on both paths, the ack-stage branch (`held` never acks; `read` flips only its rows; wrong fingerprint has no effect), capability gating, each drop site, restart `unknown` including the hand-off crash window, monotonic state, an old queued copy expiring after a resend reached a session, a `read` surviving a limit and a crash, re-arm boundaries and brakes, watch open and close including the drain and inline-backlog paths, a headless worker getting no reminder, reply-before-row, server ack not closing, the prune skipping latched queues, and pending rows retrying after a restart with no relay yet. Integration: an encrypted kinded ack through the real gate, the tool on both transports, the standby verb with a holder that lacks it, peer health. E2E: a stamped peer at a full limit gets `held`, then a session, then `read`; a silent interactive session gets one reminder and one `unacknowledged`; a two-agent run proves no kinded ack starts or wakes a session. Live proof on throwaway agents, then Echo and Scout.

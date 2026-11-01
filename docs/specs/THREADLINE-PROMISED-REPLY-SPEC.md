---
title: Threadline promised reply — a "Composing response..." ack is always followed by a reply or a notice
status: DRAFT v3 (Phase 2 rewrite against spec-converge round 1, 2026-11-01; round 2 owed)
author: Dawn
reviewer: Echo
closes: instar #2117 gaps F and H
builds-on:
  - src/threadline/autoAck.ts (createRelayAckSettler, encode/decodePlaintextPayload, isAutoAckInbound)
  - src/threadline/ListenerSessionManager.ts (hasCanonicalReplyFor)
  - src/threadline/ThreadlineReapRecovery.ts
  - src/threadline/recordThreadMessage.ts (the D-B append funnel)
  - THREADLINE-CANONICAL-HISTORY-SPEC.md (replication of the per-thread log)
  - #2149, #2174, #2176
  - HONEST-PROGRESS-MESSAGING-SPEC.md §B2
round-1-reports: docs/specs/reports/promised-reply-round1/
lessons-engaged: [P2, P3, P5, P17, P19, P20, P21, L5, L15, Q4]
---

# Threadline promised reply

## Problem

After #2149, #2174 and #2176, "Message received. Composing response..." is sent only once a
live consumer holds the message, and a message that will not be answered gets "Message
received." One case is left: **a consumer received the message, the promising ack went out,
and no reply ever followed.** On thread-ff759fcf the ack went out at 20:21 UTC and nothing
followed for over three hours. To the sender that looks exactly like a reply in progress
(gap H).

## Alternatives considered

- **Caller-side timeout only.** The asking side already knows an ack arrived and no reply
  followed, with no wire change. But it cannot tell "slow" from "the session died", and it is
  the acking side that made the promise. Caller-side display of "acked N min ago, no reply" is
  cheap and worth doing separately; it does not replace this.
- **Reuse `'ack'` as the wire type.** Rejected in v2: every receive path consumes an ack as
  "delivery ack, not routed".
- **A shared per-thread ledger (gap D).** Out of scope; see the end of this document.

## Frontloaded decisions

Each of these was open in v2 and is now decided. The wire format (decisions 4 and 5) is a
published interface and is final at v1; the dry-run does not soak it, so it is decided here.

1. **Trigger.** An obligation is recorded where `createRelayAckSettler.settle()` returns
   `'sent'` for a **promising** ack — whatever its text (`deps.autoAckMessage` included), not by
   matching `DEFAULT_AUTO_ACK_MESSAGE`. The non-deferred path (`!input.deferSend`) also records
   one, with `consumer: 'unknown'`.
2. **What `settle()` carries.** It is extended to take
   `{ outcome, consumer: 'session' | 'listener' | 'pipe' | 'unknown', sessionName?: string,
   canonicalMessageId: string }`. Each routing branch passes what it has: `router-delivered` and
   `pipe-spawned` pass a session name; `listener-delivered` passes `consumer: 'listener'` and no
   name. `canonicalMessageId` is the **canonical inbox entry id** (which is a generated UUID when
   the inbound arrived unkeyed, ThreadlineBootstrap "UNKEYED" path), never the raw wire id.
3. **What closes an obligation.** One check, run by the sweep (§3) at fire time, not hooks on
   every outbound path:
   - `hasCanonicalReplyFor(threadId, inboundMessageId)` is true (this already excludes
     `relay-rejected`, so a refused reply never closes it); **or**
   - the thread's canonical history holds any outbound **non-ack, non-notice** message to that
     peer after `ackedAt` whose outcome is not `relay-rejected`.

   The v2 same-session fallback is dropped: outbound session names are optional on relay-send
   and absent on the listener and forwarded paths, so it could not work where it was needed.
   The second rule may close an obligation on a reply about a different subject. That is the
   chosen trade: a missed notice is a smaller harm than a false "no reply yet" after a real
   reply. Forwarded sends (relayForward.ts) are seen because the holder's relay-send records
   them in canonical history; in addition, the forward now carries `inReplyTo` so the first rule
   can match them too.
4. **Wire type and payload.** `type: 'reply-notice'`, encoded as
   `{ text, type: 'reply-notice', notice: { v: 1, items: [{ inboundMessageId, ackedAt, reason }] } }`.
   `encodePlaintextPayload` / `decodePlaintextPayload` gain the `notice` field and parse it
   strictly (unknown keys dropped, `reason` checked against the closed set, ISO times). `text` is
   our fixed English template, carried only for peers that render it as content; a current
   receiver ignores `text`, renders from `notice` itself, and stores no free text from the peer.
5. **Reasons (closed set).** `still-working`, `session-ended`, `restart-lost`, `no-reply-needed`.
   Each item carries its own reason, so a collapsed notice is never false for any of its items.
6. **Transport.** Encrypted to the peer's pinned key when a pin exists (a typed control op, as
   `sendInviteControlToKey` does), plaintext otherwise. Because pinned peers get it encrypted,
   `refuseDowngrade` needs **no** exemption and none is added.
7. **Trust gate.** `reply-notice` becomes its own operation in the trust table, allowed for
   `verified`, `trusted` and `invite`; refused for `untrusted` and for unknown senders under
   enforcement. Files: relayUnknownSenderTrust.ts, AgentTrustManager.ts (`DEFAULT_ALLOWED_OPS`),
   InboundMessageGate.classifyOperation.
8. **Receiver validation (forgery).** A receiver accepts a notice only if: the thread exists with
   that exact peer fingerprint; **every** `inboundMessageId` is a message **we** sent on that
   thread to that peer; every `ackedAt` parses and lies within the last 24h and not in the
   future; every `reason` is in the closed set. Otherwise it is dropped and logged. At most 10
   stored notices per peer per 24h; beyond that they are dropped and counted.
9. **Older peers get no notice.** A notice is sent only to a peer that advertises the
   `reply-notice` capability. This replaces v2's "at most one round" bound, which was wrong: an
   older peer routes any non-ack to a session, whose real reply our side would route in turn.
   The cost, stated: an older peer that received a promising ack still sees nothing after a stall.
10. **Deliberate close is not silent.** `threadline_promise_close` sends a notice with reason
    `no-reply-needed`. The peer was promised a response, and silence would recreate gap H.
11. **Unmeasurable state suppresses.** If the reason cannot be determined (SessionManager
    unavailable, consumer `unknown` with no reader to check), no notice goes out that tick; the
    obligation is re-checked next tick and expires at the ceiling. It never defaults to
    `still-working`.

## Design

### 1. The obligation

Recorded at decision 1, as a `kind: 'promise'` entry in the thread's canonical log (not a
separate store), with state transitions appended as further entries:

```ts
interface PromisedReply {
  inboundMessageId: string;   // canonical inbox entry id (decision 2)
  threadId: string;
  peer: string;               // verified fingerprint, or relay address if unverified
  ackedAt: string;            // ISO
  ackedByMachine: string;
  consumer: 'session' | 'listener' | 'pipe' | 'unknown';
  sessionName?: string;
  state: 'open' | 'replied' | 'closed' | 'sending' | 'noticed' | 'expired';
  closeReason?: 'no-reply-needed' | 'answered-elsewhere' | 'duplicate' | 'expired-during-outage';
  noticeVerdict?: 'delivered' | 'queued' | 'rejected' | 'unconfirmed' | 'unknown';
}
```

Note on v2's premise: relay inbounds **are** appended to the canonical inbox
(`appendCanonicalInboxEntry`); what is unreliable is the per-thread log (Echo's measurement on
his machine, not re-verified here). `isAuthenticatedThreadlineInbound` accepts the union, so a
reply naming the recorded id passes relay-send validation.

### 2. Multi-machine posture

**Unified, by riding the canonical history.** Obligation entries live in the per-thread log, so
they replicate wherever THREADLINE-CANONICAL-HISTORY-SPEC replicates that log. **Only the current
relay holder for the thread runs the sweep** for it. After a failover the new holder sees the
open obligations and any reply recorded by either machine. If replication has not delivered the
entries, the new holder has nothing to notice and sends nothing; a missing notice is the honest
failure, a guessed one is not. Backups: per-thread logs are excluded from BackupManager today;
obligations are deliberately not restored, since the 24h ceiling makes them short-lived.

### 3. The sweep and the notice

- **Scheduler.** One periodic sweep every 60s over an in-memory index of open obligations,
  loaded from the canonical logs at boot and updated on append. Cost per tick is O(open
  obligations). No per-obligation timers.
- **Firing.** An obligation still `open` at **T** (default 30 min) after `ackedAt`, after the
  close check (decision 3) fails, gets its reason:
  - `consumer: 'session'`/`'pipe'` with a name: session alive → `still-working`; gone and the
    server restarted since `ackedAt` → `restart-lost`; gone otherwise → `session-ended`. A restart
    alone never picks `restart-lost`, since sessions outlive restarts.
  - `consumer: 'listener'`: the warm-listener heartbeat reader is alive → `still-working`, else
    `session-ended`.
  - otherwise: decision 11 (suppress).
- **Reap recovery.** If ThreadlineReapRecovery holds a recovery entry for this inbound,
  `session-ended` and `restart-lost` are suppressed and the obligation stays open; a recovery
  reply then closes it through decision 3.
- **Collapse.** All open obligations on one thread with one peer fold into **one** notice, sent
  at the oldest one's T, listing each with its own reason.
- **At most once, across a crash.** Order: append `sending` → send → append `noticed` with the
  verdict. The verdict wait is 60s; no verdict by then is `unconfirmed`. On startup a `sending`
  entry with no verdict becomes `noticed` with verdict `unknown` and is **never** re-sent. No
  retry on any verdict. No second notice for the same obligation.
- **Brakes.** At most one notice per peer per hour and 20 per agent per hour. An obligation that
  is held back by a cap folds into that peer's next notice, or expires at the ceiling. On
  startup, open obligations older than the **age ceiling (24h)** become `expired`
  (`expired-during-outage`) with no notice. Standard B: this is a peer-facing notice, not an
  operator notice; the heal step is reap recovery, which runs first.
- **A late real reply is always sent**, whatever the obligation's state.
- Worked timeline: ack at 10:00 → no reply → 10:30 notice `still-working` (if the peer's hourly
  slot is free) → reply at 11:15 is sent normally and the obligation stays `noticed`. If the slot
  was taken at 10:30, the item waits for the next free slot, and is expired at 10:00 next day if
  none comes.

### 4. Sending side, symmetry

The server sends the notice directly (not via `/threadline/relay-send`), so it records its own
outbound through `recordThreadMessage` with `kind: 'reply-notice'` and the notice's message id.

### 5. Receiving side, every path

The `reply-notice` case is added **before** the ack stage in each of the four ingress paths:
the relay handler in src/commands/server.ts, ThreadlineEndpoints.ts (`isAutoAckBody` site),
`/messages/relay-agent` in routes.ts, and ThreadlineBootstrap's plaintext decode. In each:

- validate (decision 8); on failure drop and log;
- **no** ack back, **no** routing, **no** spawn, **not** a reply for the waiter logic;
- call `recordThreadMessage` itself with `kind: 'reply-notice'`;
- **skip** `recordRelayDelivery`, the `lastInboundAt` update and the stale/dark clear in
  A2ADeliveryTracker, and the Telegram bridge mirror. A "no reply yet" notice must not make the
  peer look alive or mark our pending sends acked.

### 6. Surfaces

- `GET /threadline/peers/health` and `/threadline/peers/:fp/health` rows gain
  `lastReplyNotice: { at, reasons, count24h } | null` (receiver view) and
  `promisedReply: { open, noticed24h } | null` (sender view). `isPeerHealthBody` is updated to
  accept both.

### 7. `threadline_promise_close`

- MCP tool in ThreadlineMCPServer.ts, backed by `POST /threadline/promises/:inboundMessageId/close`
  with the agent's server token.
- Bound to the recorded `sessionName` when there is one: another session is refused unless it
  passes `operator: true`. With no recorded name, any session of the agent may close it.
- `reason` from `no-reply-needed | answered-elsewhere | duplicate`. `no-reply-needed` sends the
  notice (decision 10); the other two record the close and send nothing, because the peer has
  had, or will have, its answer.

### 8. Awareness and migration (in this PR, not later)

- Awareness text for `threadline_promise_close` in src/scaffold/templates.ts, the
  PostUpdateMigrator awareness section, and the warm-session prompt (ListenerSessionManager.ts,
  next to the `inReplyTo` instruction).
- PostUpdateMigrator step adding the `threadline.promisedReply.*` config keys with defaults.
- Config keys, read per sweep, not at boot: `enabled` (false), `mode` (`dry-run`),
  `noticeAfterMin` (30), `ageCeilingHours` (24), `perPeerPerHour` (1), `perAgentPerHour` (20).

### 9. Rollout

Dev-gated, default off. First stage **dry-run**: obligations recorded, would-be notices logged,
nothing sent. Kill switch disables both. **Forcing function:** enabling dry-run writes
`state/promised-reply-rollout.json` with a 14-day deadline; the peers-health surface reports
`rollout: OVERDUE` past it until the flag is flipped or the file records a reason to stay. Flip
criterion: in the window, every would-be notice matches a real stall (no reply in canonical
history at fire time) and none fired on a thread that got a reply before T.

Rollback: disabling `enabled` leaves recorded entries inert; `reply-notice` entries already in
peer logs stay; a receiver downgraded to a build without the case treats it as content (and a
current sender would no longer be sending to it, per decision 9).

## Tests

1. Ack, reply with matching `inReplyTo`: closed, no notice.
2. Ack, other non-ack outbound to the peer on that thread after `ackedAt`: closed (decision 3, second rule).
3. Ack, reply `relay-rejected`: stays open; notice at T.
4. Ack, no reply: one notice at T, `still-working`.
5. Three acks on one thread, no replies, mixed session states: one notice, per-item reasons.
6. Restart with open obligation past T, session gone: `restart-lost`. Session alive: `still-working`.
7. Late real reply after the notice: sent.
8. Each of the four receive paths: no ack, no route, no spawn, entry recorded, liveness and ack accounting untouched (wiring-integrity test).
9. Forged notice (id we never sent; wrong fingerprint; future time; unknown reason): dropped and logged.
10. Unkeyed inbound: obligation keyed on the canonical entry id; reply naming it closes it.
11. Forwarded reply from a standby machine: closes the holder's obligation.
12. Failover with replicated log: new holder sweeps; without replication: no notice.
13. Deliberate close `no-reply-needed`: one notice; `answered-elsewhere`: none; wrong session without `operator`: refused.
14. Crash after `sending` before verdict: startup marks `unknown`, never re-sends.
15. Startup after 3-day outage, 10 open to one peer: all expire, none notice. Fresh ones: caps hold.
16. Burst: 1,000 obligations across 200 peers: caps hold, sweep tick bounded.
17. Relay rejecting every notice: one attempt each, recorded, no retry.
18. Trust gate: allowed for verified/trusted/invite, refused for untrusted; pinned peer gets it encrypted and is not refused as a downgrade.
19. Older peer without the capability: no notice sent.
20. Reap recovery entry present: `session-ended` suppressed; recovery reply closes it.
21. SessionManager unavailable: no notice that tick.
22. Dry-run: nothing sent, would-be notice logged; rollout file written with deadline.

## Open questions

- Does a peer capability advertisement exist that decision 9 can read? If not, this PR adds
  `reply-notice` to the capability list exchanged at pairing. To verify before round 2.
- Echo's 3-inbound/465-outbound figure is his measurement and has not been re-checked here.

## Out of scope

The shared per-thread ledger (gap D) is a separate, later spec, written only if this one leaves
a real need. See THREADLINE-THREAD-LEDGER-SPEC.md (v0, superseded for F/H by this document).

## Still owed

spec-converge round 2 against this v3, and the ELI16 overview.

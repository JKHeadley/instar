---
title: A2A — an ack is never acked
slug: a2a-ack-never-acked
date: 2026-10-08
author: echo
tracking: ACT-063
parent-spec: a2a-inbound-id-ledger.md
parent-principle: "Capacity Safety — No Unbounded Self-Action"
parent-principle-fit: "One inbound message made each side send about five automatic messages and could start a full session to answer a delivery receipt. The fix removes the loop itself; the rate limiter that used to end it stays as flood protection."
binding-standards: ["Capacity Safety — No Unbounded Self-Action", "Signal vs Authority", "A Refusal Stays a Refusal — conservation of negative outcomes"]
eli16-overview: a2a-ack-never-acked.eli16.md
approved: true
approved-by: "operator standing approval for the agent-comms track — 2026-10-06 18:57, Telegram topic 122413"
review-convergence: "2026-10-09T00:51:10.526Z"
review-iterations: 3
review-completed-at: "2026-10-09T00:51:10.526Z"
review-report: "docs/specs/reports/a2a-ack-never-acked-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Spec — an ack is never acked

**Terms.** The *auto-ack* is the short message `Message received. Composing
response...` an agent sends back automatically when a message arrives over the
relay. The *relay handler* is `handleGatePassedRelayMessage` in
`src/commands/server.ts`, which runs for every relay message that passed the
inbound gate. The *warrants gate* is `WarrantsReplyGate`, which decides whether
an inbound message deserves a reply session. The *ledger* is the inbound
message-id ledger (`a2a-inbound-id-ledger.md`).

## Problem

1. **An ack is acked.** The relay handler sends the auto-ack through
   `ThreadlineClient.sendPlaintext`, which puts `type: 'chat'` and a fresh id
   on the wire. To the receiving agent it is an ordinary message. The same
   handler runs on it and sends an ack back. The handler does compute
   `isAutoAck`, but only uses it to keep an ack from resolving a reply waiter;
   the ack send never looks at it. The exchange stops only at the per-sender
   rate limit (5 acks per 60 s): about five acks each way for one message.
2. **An ack can start a session.** The warrants gate treats the first inbound
   on a thread as first contact, which warrants a reply. When we start a
   thread, the peer's ack is the first inbound on it, because the ack reaches
   the gate like any message. The handler then spawns a session to answer a
   receipt.

Root-caused from code and live logs on 2026-10-08 (ACT-063).

## What exists (verified on `main` = 890f02396)

| Fact | Code |
|---|---|
| The ack is sent for every gate-passed relay message unless the sender is `untrusted`, the type is `status`, `threadline.autoAck` is `false`, or the sender is rate-limited. | `src/commands/server.ts:18294-18300` |
| `sendPlaintext` hardcodes `type: 'chat'` and mints a new id. | `src/threadline/client/ThreadlineClient.ts:365-372` |
| `isAutoAck` is a prefix test (`Message received.` / `Message received,`) used only for the reply waiter. | `src/commands/server.ts:18267`, `:18289`; `src/server/routes.ts:34825` |
| A plaintext envelope reaches the handler through the `unknown-sender` decode, which passes the payload's `type` through unchanged and skips the inbound gate's operation check. | `src/threadline/ThreadlineBootstrap.ts:300-357` |
| The only test of the wire type in the handler is `msgType !== 'status'`. No code tests for `'chat'`. | `src/commands/server.ts:18295-18296` |
| The first inbound on a thread warrants a reply (first contact), whatever its words. | `src/threadline/WarrantsReplyGate.ts:282` |
| Two more inbound paths reach a router: the signed HTTP route goes straight to `handleInboundMessage`; `/messages/relay-agent` runs the warrants gate first. Neither sends an ack. | `src/threadline/ThreadlineEndpoints.ts:700`; `src/server/routes.ts:34868`, `:34956` |

## Invariant

**An ack is never acked, never reaches the warrants gate or any router, and
never spawns a session. It only records delivery.**

"An ack" here means a *recognised automatic ack*: a message carrying the wire
type `ack`, or one that is exactly the fixed ack sentence (Design §2). Any
other acknowledgement — a hand-written "thanks", or an older peer's own custom
ack sentence — is an ordinary message and gets the warrants gate's normal
decision, which this fix does not change.

## Design

### 1. The ack stage runs first (relay handler)

A new module `src/threadline/autoAck.ts` holds the stage so tests run the same
code. `runRelayAckStage` is called in the relay handler right after the reply
waiter check. That check never resolves a waiter with a recognised ack (typed
or exact-sentence), nor with a message that merely opens like one:

- **The inbound is an ack** → record the delivery ack (`recordInboundAck`),
  write the ledger disposition `no-reply` through the ledger ticket, and return
  from the handler. Nothing is sent. The inbox append, the Telegram mirror, the
  warrants gate, the pipe spawner, the listener inbox and the router are all
  after this point and are not reached.
- **Anything else** → continue as before. Our own ack is not sent here: it is
  held until routing has an outcome (Design §6) and then sent under the
  existing four conditions.

**How a receipt is matched to what we sent.** Unchanged, and by thread, not by
message: `recordInboundAck` marks the oldest message still awaiting an ack on
that thread as acknowledged, and bumps the peer's last-heard clock. With two
messages outstanding on one thread, one ack clears the older and a second ack
clears the newer; an ack with nothing outstanding changes nothing. This is the
rule every inbound message on a thread already follows. The fix makes it more
accurate: one message now produces one ack, where the loop produced about five
and each one cleared another outstanding message.

### 2. An ack is recognised by a wire type, with the old text kept

- `ThreadlineClient.sendAck` sends the same plaintext envelope as
  `sendPlaintext` with `type: 'ack'`. The handler uses it for the auto-ack.
  `sendPlaintext` is unchanged (`type: 'chat'`).
- `isAutoAckInbound({ type, text })` is structural. It is true when
  `type === 'ack'`, **or** when the whole message, trimmed, is exactly the
  fixed sentence every release before the type sent:
  `Message received. Composing response...`. The second branch recognises acks
  from older peers. It is an exact whole-message match against one constant our
  own software generates — never a prefix, never a word list.
  `Message received. Deploy the fix now.` is content and is handled as content.
- The old prefix test (`Message received.` / `Message received,`) is kept as
  `looksLikeAutoAckText` for the one thing it did before: a message that opens
  like an ack is not handed to a reply waiter as "the reply". It stops nothing.
- An older peer configured with its own ack sentence is not recognised by the
  stage. Its ack reaches the warrants gate, as it does today.

Recognition is a protocol fact about a message our own software generates, not
a reading of what a peer meant. No judgment point is added.

**Backward compatibility: `type: 'ack'` is safe to send to an older peer.** A
plaintext envelope reaches an older peer's handler only through the
`unknown-sender` decode, which copies the payload's `type` into the message
without checking it and bypasses the inbound gate's operation check. The older
handler's only test of the type is `!== 'status'`. So an older peer treats
`type: 'ack'` exactly as it treated `type: 'chat'`: no message is dropped and
nothing new happens there. The alternative (keep `type: 'chat'` and add an
`ack: true` field) was not needed, and would have been lost on the way: the
decode keeps only `text`, `type` and `resend`.

**What "older peer" was verified against.** The receiving code read for this
claim is `main` at 890f02396, the release this fix is built on (v1.3.1326).
The repository history before 2026-08-14 is squashed, so releases older than
that could not be read and are unverified. The mixed-version tests run that
same pre-fix handler logic against the new one. The pairing table below
assumes the default ack sentence and a peer that does not hold the other
side's keys (the path on which a plaintext ack is delivered at all).

What each pairing does with one message:

| Sender of the message → receiver | Acks sent | Sessions |
|---|---|---|
| new → new | receiver 1, sender 0 | 1 (the receiver answering) |
| new → older | older 1 (text), new 0 — recognised by the exact sentence | 1 |
| older → new | new 1 (typed), older acks it once (old habit), new consumes that | 1, plus whatever the older peer's own gate does with our ack, as today |
| older → older | about 5 each way (unchanged, their code) | unchanged |

### 3. The warrants gate is not changed

Once the stage consumes a recognised ack ahead of the gate, the gate never sees
one, so the session spawn in Problem 2 cannot happen. The gate's order stays as
it is: the first inbound on a thread is first contact and warrants a reply.

That matters for real replies. A peer's genuine first reply can be very short
(`lgtm`, `will do`). It is the first inbound the gate sees on the thread now
that the ack is gone, it still warrants a reply, and so it still reaches the
router, which is where a reply on a thread started from a Telegram topic is
shown in that topic. Moving the gate's acknowledgement word list ahead of
first contact would have hidden those replies and let a word list decide
before the classifier; it is not needed to stop the loop and is not done.

### 4. The other inbound paths

The field mapping on HTTP: `message.body` is either a string (the text, with no
type) or an object whose `content` (else `text`) is the text and whose `type`
is the wire type. Both HTTP routes call `isAutoAckBody(message.body)`, and on
an ack record delivery, write `no-reply` and return before the router.
`/threadline/messages/receive` does so right after its own delivery record.
`/messages/relay-agent` does so after auth, the loop check and the ledger
commit, and before `messageRouter.relay`, so the ack is not saved to the
message store either (and so also before the warrants gate). Neither route
sends an ack, so there was no loop there; this closes the spawn.

### 5. The rate limiter stays

The per-sender limiter (5 per 60 s, `threadline.ackRateLimit`) is moved into
`createAckRateLimiter` unchanged. It still bounds how many acks a peer sending
many real messages gets back.

### 6. Our own ack waits for the routing outcome

The default ack text promises a reply ("Composing response..."). A hand-off
after the ack stage can reach no live consumer, so an ack sent before routing
can promise a reply that never comes. The relay handler therefore defers its
own ack for **every** inbound message (`deferSend: true`) and settles it once,
at the exit the handler actually takes, through `createRelayAckSettler` in
`src/threadline/autoAck.ts`. Each exit names one outcome:

| Exit of the relay handler | Outcome | Ack sent |
|---|---|---|
| The inbound is an ack | (none — the stage returned) | none; an ack is never acked |
| Warrants gate suppresses: a no-reply verdict or an exhausted loop budget | `no-reply` | `Message received.` (`NO_REPLY_ACK_MESSAGE`), which promises nothing |
| A pipe session was created (`pipeSpawner.spawn` returned `spawned: true`) | `pipe-spawned` | the promising ack |
| The message was appended to the warm-listener inbox and a live reader is still proven | `listener-delivered` | the promising ack |
| The message was appended to the warm-listener inbox and the reader's heartbeat went stale in between | `listener-queued` | none |
| `ThreadlineRouter` returned `delivered === true` (cold spawn, resumed or warm session, topic session) | `router-delivered` | the promising ack |
| `ThreadlineRouter` returned anything else (refused, queued, failed) | `router-undelivered` | none; a queued refusal is logged as queued |
| The handler threw before any exit | (never settled) | none |

**A queued capacity refusal gets no ack.** When the spawn manager refuses a
spawn for a transient reason (for example `Session limit reached (5/5)`), its
refusal funnel tries to keep the message for a later spawn, and the router
returns `queued: true` only when the queue actually admitted it (the queue
refuses when it is globally full, or when a held backlog is at its per-agent
cap). Either way the result is `router-undelivered`, and no ack is sent. We do
not send a third fixed "received, queued" text either:

- The queue is in memory, bounded per agent and globally, expires entries after
  10 minutes, and a later arrival can evict an older entry. "Queued" is a hope
  of a later session, not a hand-off to one.
- A new ack text is recognised as an ack only through the `ack` wire type
  (Design §2). A peer from before the wire type routes any ack text to a session
  as a message, so a queued receipt would spend a session on that peer exactly
  when our side has none to spare.

The server log names the case ("queued for a later session spawn: Session
limit reached (5/5) — no live session has it yet"), so a queued message is not
read as a lost one. The ledger records it as `handoff-failed`, not as a
hand-off, so a resend from the peer is delivered instead of being dropped by
message id while the original waits in that bounded, expiring queue. If the
queued message later reaches a session, that session's reply is the sender's
acknowledgement.

**The promising ack is sent only once the injected text has actually left the
prompt.** The verdict behind `router-delivered` on the topic path is the
confirmed paste (`SessionManager.injectPasteNotificationObserved`): the
injected marker is polled at the input prompt over the 7.5 s recovery window.
That check alone gave a false negative on a BUSY session: Claude Code holds text
typed mid-turn as queued input at the prompt and reads it at the next tool
round, which looks identical to "stuck at an idle prompt" (a live topic session
received a reply at 22:21:27Z on 2026-10-12 while the server logged
"failure-visible (no live session received it)" and withheld the ack). The fix
makes a third verdict, and keeps it PROVISIONAL:

- `submitted` — the marker left the prompt inside the window: delivered.
- `stuck` — the marker is still at an IDLE prompt after the window: not
  delivered (`failure-visible`, surfaced in the topic, no ack).
- `queued-busy` — the marker is still at the prompt AND the pane shows Claude
  Code's mid-turn footer (`paneShowsClaudeWorking`, the same indicator
  `verifyInjection` already uses to avoid firing a recovery Enter into a working
  pane). This is NOT reported as delivered: the footer is screen text, and a
  stale footer over an idle prompt would make stuck text look queued. The
  handler reports `live-inject-pending`, the router returns `delivered: false`
  with a `deliveryPending` promise, and the relay handler does not settle the
  ack. A bounded, non-blocking watch re-captures the pane (every 5 s for a
  minute, then every 15 s) until the marker is gone (`submitted` → the route
  finishes as `live-inject`, the commitment is delivered, the promising ack is
  sent — once, through the one-shot settler) or the prompt is idle again with
  the marker still there on two consecutive polls (`stuck` → `failure-visible`,
  surfaced, no ack), or the session disappears (`session-gone`, no ack), or the
  ceiling is reached (`ceiling`, no ack). The ceiling is 10 minutes: the Bash
  tool's maximum foreground timeout, the longest a single tool call can hold a
  turn before the queued input is read. On the ceiling the verdict is
  undelivered, never delivered. The log names the case that settled it.

The same three verdicts flow through the respawn hook's live paste (a reply
that waited for an in-flight topic spawn). The cross-machine topic-reply inject
(`a2a-topic-reply-inject`) keeps the boolean confirmation, so a busy owner
session still reads as undelivered there (its mesh RPC cannot wait for a turn to
end); that remains a known false negative on that path.

**The listener path needs a proven reader.**
`ListenerSessionManager.writeToInbox` appends to a file and succeeds whether or
not anything reads it. The manager used to report `listening` from
construction, so `shouldUseListener` sent short messages from trusted and
autonomous senders on non-topic threads into that file although nothing in the
product starts a listener session or reads it: the first ten such messages per
server run were written and never consumed. The decision now lives in the
manager and rests on proof:

- The manager starts in state `starting` with no reader proven.
- `markReaderAlive()` records a reader heartbeat. Its expected caller is
  whatever starts and supervises a warm listener session; none exists yet, so
  nothing calls it in production.
- `hasLiveReader()` is true only while the last heartbeat is no older than
  `readerHeartbeatMaxAgeMs` (default 60 s). It is never inferred from `state`.
- `shouldUseListener` returns false without a live reader, so the handler falls
  through to the router path, which spawns or resumes a session and reports
  `delivered`. The trust, size, state and overflow rules are unchanged.
- `getState()` (served at `/threadline/status`) adds `readerLive` and
  `lastReaderHeartbeatAt`, and `active` now also requires a live reader.

When the listener path is taken, a reader proved itself alive within the
freshness bound, which is the same strength of proof as the other live
hand-offs, so it gets the promising ack. The handler re-reads `hasLiveReader()`
after the write; if the heartbeat went stale in between, the entry is only
queued and no ack is sent. The canonical inbox, queue depth and reply-claim
logic do not read `state` and are unaffected.

No ack means the sender's delivery record keeps the message as unacknowledged,
which is accurate when nothing live received it. The settler is one-shot: a
path that settles and then falls through can never send a second ack. The four
send conditions (trust, type, config, rate limit) apply at settle time, so the
rate limiter is charged only for an ack that is due. The ack now arrives after
routing finished, so for a cold spawn it follows the spawn instead of
preceding it.

## What it does not do

- It does not change trust levels for unknown relay senders. That is a
  separate question with its own action item (ACT-066), unrelated to the loop.
- It does not change how an ack reaches a peer that already holds our keys:
  such a peer tries to decrypt the plaintext envelope and discards it. That is
  today's behaviour and is outside this fix.
- It does not stop older peers acking each other.
- It does not cover listener-daemon mode, where the standalone daemon owns the
  relay connection and the server's relay handler is not wired. The daemon
  sends no acks; an inbound ack lands in the listener inbox like any envelope.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Is this inbound an automatic ack? | invariant | Enumerable and structural: the wire type `ack`, or an exact whole-message match against the one fixed ack sentence. No text is interpreted. A miss falls to the warrants gate. |
| Does an ack get an ack, a gate pass or a router? | invariant | Never. |

## Multi-machine posture

**Machine-local by design.** The stage is a stateless rule applied per inbound
message on the machine that received it. It adds no stored state. The two
records it writes already exist and keep their own posture: the delivery
tracker row and the ledger row are per machine, and the ledger's pool read
(`GET /a2a/inbound-ids?scope=pool`) shows the `no-reply` row from any machine.
A standby does not connect to the relay and so never runs the handler. No user
notice is produced, and no URL.

## Frontloaded Decisions

1. **Send `type: 'ack'`; keep text recognition for older peers.**
2. **Text-only recognition is an exact whole-message match** against the one
   fixed ack sentence, because it now stops the message instead of only
   sparing a waiter. The prefix test keeps only its waiter role.
3. **A consumed ack is not written to the inbox, the message store or a bridge
   topic.** It
   leaves a ledger row (`no-reply`), the delivery record, and a server log line
   that names how it was recognised: `by type` (the sender declared it) or
   `by exact-text` (the message was the fixed sentence and nothing else). No
   message text is stored; neither branch can hold a message with other
   content, by construction.
4. **Ships ungated.** An ack loop is a defect in always-on behaviour, not a
   feature to trial; a dark flag would leave the loop running on the fleet.
5. **`ack` is terminal for the ledger** (`no-reply`), so a redelivered copy of
   the same ack is dropped by id.

## Open questions

*(none)*

## Rollback

Revert the commit and release. No stored format changes; ledger rows written as
`no-reply` stay valid. A reverted receiver treats a typed ack from a newer peer
as it treats any plaintext message (see the pairing table). There is no flag to
flip, by decision 4.

## Agent awareness and migration parity

No route, config key or hook is added or changed. `threadline.autoAck`,
`autoAckMessage` and `ackRateLimit` keep their meaning. Design §6 changes what
an ack, and a missing ack, tell a peer, so the CLAUDE.md template and
`migrateClaudeMd` carry one section, "A2A ack waits for a live session" (its own
sniff key, framework-shadowed).

## Tests

- **Unit** — `tests/unit/threadline/autoAck.test.ts`: recognition on both sides
  of every boundary; the stage with a real ledger ticket and a real delivery
  tracker on a thread we started (nothing sent, `no-reply`, delivery recorded);
  the four no-ack conditions; the limiter; the wire format through a real
  `ThreadlineClient`. `tests/unit/threadline/ack-stage-wiring.test.ts`: the stage sits before
  every side effect and router in the real handler and both HTTP routes.
- **Integration** — `tests/integration/threadline/ack-never-acked.test.ts`: two
  handlers back to back with one message (at most one ack per side, at most one
  session in total); the pre-fix pair shown looping in the same harness; mixed
  old/new pairs; a peer's first reply of `lgtm` on a thread we started still
  warrants a reply while its typed ack does not; both HTTP routes.
- **E2E** — `tests/e2e/threadline/ack-never-acked-alive.test.ts`: a real
  relay server and two agents booted with the real bootstrap; one message.
- **Design §6** — unit: every outcome of the settler, its one-shot rule and the
  four send conditions (`autoAck.test.ts`); every exit of the real handler
  settles exactly once, and the inbound-ack exit never does
  (`ack-stage-wiring.test.ts`). Integration:
  `tests/integration/threadline/relay-ack-waits-for-delivery.test.ts` runs a
  first message on a new thread through the real router (spawned, denied,
  queued), the real listener manager (no proven reader → router path and no
  inbox file; fresh heartbeat → listener path; stale heartbeat → router path),
  the real router over the real `SpawnRequestManager` (session limit reached →
  queued, no ack, logged as queued; a free slot → delivered and acked; refused
  with the queue full → not queued, no ack), and the real client wire encoding.
  `tests/unit/ListenerSessionManager.test.ts`
  covers the heartbeat on both sides of the freshness bound.
  `tests/unit/session-inject-observed.test.ts` covers the three paste verdicts
  and the watch (text taken later → submitted; idle with the marker twice →
  stuck; stale footer → ceiling, never submitted; session gone; capture error).
  `tests/integration/threadline/delivered-verdict-per-route.test.ts` asserts
  `delivered === true` on every delivering route (live inject idle, respawn,
  cold spawn, resume, warm spawn, the router's live inject) and the
  busy-session cases end to end through the real handler, router and settler
  (one late ack when the text leaves the prompt; none on a stale footer or
  ceiling; failure-visible surfaced). E2E: over the real relay, a message that
  reaches no live session leaves the sender's record unacknowledged, and the
  next, delivered, is acked.

## Maturation plan

- **test-agent-live:** the E2E above is the throwaway pair: two real agents on
  a real relay, one message, one ack, one session.
- **dev-agent-live:** live on the development agent from the release that
  carries it. For one week, count `[relay] delivery ack from` lines against
  `[relay] Spawned session` lines for threads this agent started.
- **fleet:** the same release; ungated (Frontloaded Decision 4).
- **graduation criterion:** over the dev-agent week, at least one outbound
  message to a peer shows exactly one `delivery ack … recorded` line and no
  session spawned for that thread's ack; and every such line reads `by type` or
  `by exact-text` (the only two ways the stage can fire). A zero count of
  recorded acks is not a pass.
- **dark-window:** none — the fix is live on release. If the criterion is not
  met within 14 days of the release, the reason and a new date are recorded on
  ACT-063.

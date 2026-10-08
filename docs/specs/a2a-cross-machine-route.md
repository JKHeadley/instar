---
title: A2A cross-machine route — forward a send to my machine that holds the relay
slug: a2a-cross-machine-route
date: 2026-10-08
author: echo
status: draft
parent-spec: a2a-backup-routes.md
depends-on: a2a-honest-delivery-outcomes.md
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "A machine of mine that does not hold the relay connection answers 'not connected' although the agent is connected. The send goes out through the machine that holds the connection, and that machine's real verdict comes back."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "Capacity Safety — No Unbounded Self-Action", "Ownership-Gated Side Effects"]
eli16-overview: a2a-cross-machine-route.eli16.md
---

# Spec — A2A cross-machine route

When a machine of mine cannot use the relay and another of my machines holds the connection, a send
is forwarded once to that machine over the existing signed mesh. That machine, the *holder*, runs
the complete ordinary relay-send route and owns the records, as it does for its own sends. A reply
on a thread bound to a Telegram topic is delivered to that topic's live session on whichever of my
machines has it. Any failure degrades to behaviour that exists today. A *rope* is one network path
between two of my machines (Tailscale, LAN or Cloudflare).

## Problem

Evolution action ACT-052: a machine of mine that does not hold the relay connection cannot send to
other agents; its sends answer 503. The live case is a standby or any pool machine that is not the
holder: it never connects, so this happens on every send.

The relay event log (`logs/threadline-relay-events.jsonl`, 2026-08-19 to 2026-10-08, 80 events) has
29 displacements, 11 own restarts, 11 unexplained drops and 1 relay server shutdown. The
displacement evidence is stale: 28 of the 29 were in August and the last was 2026-09-05. A displaced
client now reclaims its connection after 15 minutes (`src/threadline/ThreadlineBootstrap.ts:376-394`).

**Why forward.** The relay admits one connection per agent identity, so a non-holder that connected
would displace the holder. Letting the relay accept several connections per identity is a relay
protocol change with its own delivery fan-out problem, and is out of scope.

## What exists (verified at `main` 890f02396)

| Fact | Code |
|---|---|
| relay-send answers 503 when the relay client is absent or not `connected`. The message id, thread and nickname resolution exist by then. | `src/server/routes.ts:36677-36680`, `:36163`, `:36167`, `:36084-36160` |
| The route takes `originTopicId` from the body, or looks it up from the sending session's name, which only the sending machine can do. | `src/server/routes.ts:35892`, `:36018-36021` |
| Three checks are keyed on `inReplyTo` or `originSessionName`: the warm-reply rule, the authenticated-inbound rule and the reply claim. The negotiator gate is per machine. | `src/server/routes.ts:35904-35931`, `:36210-36216` |
| The relay client is created only when the relay is wanted and this machine is not a standby. The bootstrap knows this at boot; the route context does not. | `src/threadline/ThreadlineBootstrap.ts:175-180`, `:253-262`; `src/commands/server.ts:18081` |
| When the listener daemon owns the relay, the client is present but never connects; the server records that. `banSuspected` is true after a ban frame. | `src/threadline/ThreadlineBootstrap.ts:233-240`, `:287`; `src/commands/server.ts:18102`; `src/threadline/client/ThreadlineClient.ts:868` |
| A signed, recipient-bound, replay-safe RPC exists between my own machines, with a registered-peer class and late-bound senders. An unknown verb answers `claim-unauthorized`. | `src/core/MeshRpc.ts:30-51`, `:312-324`, `:462-470`, `:499-500`; `src/commands/server.ts:23466-23480`, `:23947-23958` |
| Every server reports `relay.state` and `fingerprint` on the unauthenticated `/threadline/health`. | `src/threadline/ThreadlineEndpoints.ts:253-275` |
| On send, origin capture records a `threadline-reply` commitment (no beacon) and the thread's topic. The redrive engine selects such commitments. | `src/threadline/TopicLinkageHandler.ts:277-296`; `src/monitoring/CollaborationRedriveEngine.ts:213` |
| On a reply, topic linkage checks the sender, then needs a **local** session or resume entry for the topic; without one it reports the topic expired and the message is then processed normally. | `src/threadline/TopicLinkageHandler.ts:341-347`, `:355-378`; `src/commands/server.ts:18292-18294` |
| With a local session it builds a payload and injects it; a failed inject is `failure-visible`, which always posts the reply into the Telegram topic. Any `routed` outcome returns `handled: true` before a spawn. | `src/threadline/TopicLinkageHandler.ts:386-437`, `:462-485`; `src/threadline/ThreadlineRouter.ts:700-711` |
| A confirmed inject exists; it reports whether the session consumed the text (up to 7.5 seconds). | `src/core/SessionManager.ts:6880-6902` |
| An ownership registry answers which machine owns a topic. | `src/server/routes.ts:20842`; `src/commands/server.ts:22342-22350` |
| Send results reach agents through `SendMessageResult` and the MCP tool. | `src/threadline/ThreadlineMCPServer.ts:133-149`, `:681` |

## Threat model

Only my own registered machines can send the two new verbs: each envelope is signed by the sender
machine, bound to the recipient and nonce-guarded. A compromised machine of mine can already speak
as the agent and type into its own sessions, so the verbs add no authority. Message bodies cross
between my machines signed but not encrypted by the mesh. Tailscale and Cloudflare ropes encrypt in
transit; a LAN rope is plain `http://` (`src/core/MeshUrlAdvertiser.ts:260-263`). This is accepted
for ordinary messages. Credential sends are refused on the sender and never cross; the holder
cannot re-check that, because the credential label is a caller hint.

## Design

### 1. Trigger

At the 503 point (`routes.ts:36677`) a forward is tried only when all of these hold:

- this machine cannot send for one of two reasons: **(a)** its relay client is present, not
  `connected`, not `banSuspected`, and the daemon does not own the relay
  (`inboundIdLedgerDaemonDeferred`); or **(b)** its client is absent because it is a standby
  (`relaySuppressedByStandby`: the boot-time value `relayWanted && config.relayStandby`, threaded
  from the bootstrap to the route context, never recomputed from live config);
- the send is not a credential share (`isCredentialShareSend`), and is not itself a forwarded one;
- a holder is found.

**Finding the holder.** The sender reads `/threadline/health` from its active peer machines in
parallel (at most 8, 2 seconds in total). A peer qualifies when `relay.state === 'connected'` and
its `fingerprint` equals this machine's own. The forward goes over the URL that answered the probe.
The holder's own check is the authority. Otherwise the answer is today's 503: relay off by config,
daemon-owned relay, ban, or no holder.

### 2. Forward

The sender has already run its own checks: the warm-reply rule, the authenticated-inbound rule, the
reply claim, the negotiator gate and the credential refusal. It then sends one mesh verb,
`a2a-relay-forward`: `{ targetAgent, resolvedFp?, body, messageId, threadId, resend, originTopicId?,
purpose? }`.

- `resolvedFp` is the sender's own nickname resolution, so the holder cannot re-resolve the name to
  a different agent.
- `threadId` is `effectiveThreadId`. `resend` is `classifyFallthrough(localPostOutcome).marked`.
- `originTopicId` is resolved by the sender, because the session-to-topic lookup is local to it.

One attempt, 15 seconds, no retry. The route adds at most 17 seconds. The sender writes no A2A
record; it writes one log line, `[a2a-forward] id=<messageId> to=<machine> outcome=<outcome>`, a
counter on the authed `/health`, and releases a reply claim on a 2xx answer.

### 3. The holder runs the ordinary route, by a loopback call

The handler POSTs to its own `POST /threadline/relay-send` on loopback, with the server's token and
a header carrying a secret generated in memory at boot. The route body is about a thousand lines of
closure state that writes the response as it goes. A loopback call reuses it unchanged; lifting it
is a larger and riskier change for the same result.

The call's body is `{ targetAgent: resolvedFp ?? targetAgent, message, threadId, originTopicId,
purpose, waitForReply: false }`. `inReplyTo` and `originSessionName` are never sent.

| On the holder, for a forwarded request | |
|---|---|
| **Runs** | required fields and the 64 KiB size limit; target resolution (a fingerprint skips the nickname lookup); the local-delivery branches; the 503 guard on its own relay client; the relay send; tracker row; thread leg; origin capture and its commitment; the 3-second verdict wait; outbox entry; bridge mirror |
| **Skipped because the field is absent** | the warm-reply rule, the authenticated-inbound rule and the reply claim (all need `inReplyTo` or `originSessionName`); the session-to-topic lookup; the reply wait |
| **Skipped only when the boot secret matches** | the negotiator gate; the §1 trigger, so a forward is never forwarded again |
| **Honoured only when the boot secret matches** | the body's `messageId` and `resend` |

So the holder never refuses a legitimate forwarded reply with a 400.

### 4. The answer

- **Provably not sent → today's 503.** Any typed mesh rejection (`ok: false` with a reason,
  including `claim-unauthorized` from an older peer, `stale-timestamp`, `replayed-nonce`,
  `unknown-sender`, and the 503 "mesh-rpc not configured"); a refused connection; the gate off on
  the holder; the holder's own 503.
- **Any other answer from the holder's route** → that status and body (a relay `rejected` is 502),
  plus `deliveryPath: 'forwarded'`, `forwardedTo: <machine nickname>`, `reply: null`, and
  `replyArrivesIn`: `'topic-session'` when the send had a topic, else `'holder-hub'`.
- **A timeout or a non-200 with no reason → `relayStatus: 'unconfirmed'`**, with the `messageId` and
  "do not resend; check delivery on <machine>". A caller that retries anyway mints a new id, as with
  today's `unconfirmed`.

`SendMessageResult` and the MCP tool rendering carry these fields, with an MCP contract test.

### 5. A reply reaches the topic's session on whichever machine has it

`TopicLinkageHandler` gains one optional dependency, `deliverToTopicOwner(topicId, buildPayload,
messageId) → 'injected' | 'not-remote' | 'failed'`. It is called after the sender check
(`TopicLinkageHandler.ts:355-364`) and before the topic-active test (`:366`).

- **`not-remote`** is decided with no network call: a local session for the topic is alive, or the
  ownership registry's `ownerOf(topicId)` names this machine or nobody. Today's code then runs.
- Otherwise the payload is built by the existing steps (`:386-405`) and sent to the named machine
  with a second verb, `a2a-topic-reply-inject`: `{ topicId, text, messageId, threadId }`, 12-second
  timeout. The ownership record is only a hint of which machine to ask.
- **`injected`** → `deliveryMode: 'live-inject'`; the existing commitment and no-Telegram logic runs.
- **`failed`** (unreachable, no live session there, older peer, timeout) → `failure-visible`: the
  holder posts the reply into the Telegram topic, as it does today for a failed inject.

**The receiver decides from its own state.** It reads its own `getSessionForTopic(topicId)`. If
that session is alive it calls `injectPasteNotificationConfirmed` and answers `{ injected: true }`;
otherwise `{ injected: false, reason }`. It never spawns and never moves the topic. A repeat is
already limited by the envelope nonce guard and by the holder's inbound-id ledger, which admits a
message id once. The receiver also keeps the last 1,000 injected message ids in memory for 10
minutes and answers a repeat `{ injected: true, duplicate: true }` without injecting.

**Invariant.** Every outcome on this branch is `routed`, so the router returns `handled: true`
before any spawn. A topic-bound reply never spawns a context-less session on the holder.

**Accepted worst case.** On a timeout the reply may have been injected and is also posted to the
Telegram topic. That is a visible duplicate note. The message is never processed twice.

The `threadline-reply` commitment stays on the holder, where the inbound path needs it. The redrive
engine that selects such commitments ships off.

**A pre-existing case this fixes.** A message sent from topic T on machine A, after which T moved to
machine B: today the reply finds no local session on A. With this branch it reaches T's session on B.

## What it does not do

- No direct route to a different agent's machine. The log shows 1 relay-server outage in 7 weeks, so
  that is a separate, evidence-gated item: ACT-065 (due 2026-10-22).
- It does not act when the relay is off by config, when the daemon owns the relay, or after a ban.
- It does not forward credentials, retry, queue or run in the background.
- **A send with no topic** (a job, an unbound session): the reply lands on the holder exactly like a
  holder-originated thread with no topic today. The sending session does not see it in-band.
- **`waitForReply` is not honoured across machines.** The answer is `reply: null` at once.
- **Ownership records exist only when the session pool stage is past `dark`.** On the fleet it is
  dark, and without a record §5 behaves as today. That is acceptable: a non-holder session can hold
  a topic only when the pool is live.
- The holder's ownership view may be stale. It is a hint; a wrong hint ends in the Telegram post.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| When a forward is tried | invariant | The conditions of §1; code decides. |
| Which checks the holder runs | invariant | The table in §3; the skips need the boot secret or an absent field. |
| What the caller is told | invariant | §4; the holder's answer is transcribed, never upgraded. |
| Where a topic-bound reply is delivered | invariant | The receiver's own live session; else the Telegram post. |

## Multi-machine posture

- **Unified.** A2A records live on the holder, the machine that holds the agent's relay connection,
  for forwarded sends and its own sends alike. They are read from any machine through the existing
  pool reads (`GET /threadline/peers/health?scope=pool`, `GET /threadline/conversations?scope=mesh`).
  Nothing new is stored.
- **Ownership-Gated Side Effects.** The only session-scoped side effect is the inject, and the
  machine that has the live session performs it after reading its own state.
- **No manual work.** A topic-bound reply returns by code; no agent instruction is needed.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| Client present, not `connected` | This machine cannot send now | Read in the same request; daemon flag false | None |
| `relaySuppressedByStandby` | The client is absent because this machine is a standby | Set at boot by the code that skipped creating the client | False → 503 |
| Peer health `connected` + own fingerprint | That machine holds my relay connection | The holder's own 503 guard when it runs the route | Wrong → 503 |
| Typed mesh rejection | The holder sent nothing | The dispatcher rejects before the handler runs | No reason → `unconfirmed` |
| `ownerOf(topicId)` | That machine has the topic | The receiver's own `getSessionForTopic` and liveness check | Stale or absent → Telegram post, or today's code |
| `{ injected: true }` | The session consumed the reply | `injectPasteNotificationConfirmed` on the receiver | Timeout → Telegram post |

## Frontloaded Decisions

1. **Forward when this machine is a standby, disconnected or displaced, and a peer holds the relay.**
2. **The holder runs the complete ordinary route, entered by a loopback call marked with a boot secret.**
3. **Checks keyed on the sending session run on the sender only; `inReplyTo` is never forwarded.**
4. **One attempt; a typed rejection is 503; only a timeout is `unconfirmed`.**
5. **A topic-bound reply is injected on the machine with the live session; any failure is a Telegram
   post; nothing is spawned on the holder.**
6. **`waitForReply` and sends with no topic are stated limits.**
7. **Dev-gated under `threadline.relayForward`.**

## Open questions

*(none)*

## Configuration

`threadline.relayForward`: `{ enabled?: boolean }`, read live on every machine. `enabled` is
omitted from defaults, so `resolveDevAgentGate` decides (live on a development agent, dark on the
fleet), with a `DEV_GATED_FEATURES` entry. With the gate off both handlers refuse and
`deliverToTopicOwner` answers `not-remote`.

## Migration parity

- `ConfigDefaults`: none (`enabled` omitted on purpose). No new files, columns or stored state.
- Two new mesh verbs. An older peer answers `claim-unauthorized`: for a forward that is today's 503;
  for an inject it is `failed`, the Telegram post.
- Additive result fields `deliveryPath: 'forwarded'`, `forwardedTo`, `replyArrivesIn`; new counters.
- CLAUDE.md template section, added by `migrateClaudeMd()` (sniff key `A2A relay forward`).

## Rollback

`threadline.relayForward.enabled: false`, read live, restores today's 503 and today's topic linkage.

## Agent awareness

Template + migrator section (`### A2A relay forward`): "When this machine does not hold my relay
connection and another of my machines does, my sends go out through that machine.
`deliveryPath: 'forwarded'` and `forwardedTo` say so; `relayStatus` is the real relay verdict, and
`unconfirmed` means unknown: I do not resend. `reply` is null. A reply to a send made from a topic
arrives in that topic's session; a reply to a send with no topic arrives on the machine named in
`forwardedTo`, in its Threadline hub. **When to use** (PROACTIVE): a user asks which machine carried a message, or where
a reply went → read `forwardedTo`, `replyArrivesIn` and
`GET /threadline/peers/health?scope=pool`."

## Tests

- **Unit:** both sides of each §1 condition (connected, ban, daemon-owned, standby, relay off,
  credential, no holder, wrong fingerprint); the §3 table, including a wrong or missing boot secret;
  each §4 class; `deliverToTopicOwner` (local session alive, owner is self, no record, injected,
  failed, timeout); the receiver (alive, not alive, duplicate id; never spawns); the MCP contract test.
- **Integration:** two real servers of one agent, a real RelayServer and a third agent. A send from
  a topic session on the standby arrives once with the sender's id and thread; all A2A records are
  on the holder; the reply is injected into the standby's topic session and nothing is spawned on
  the holder. With that session stopped, the reply is posted to the Telegram topic and nothing is
  spawned. A forwarded reply carrying no `inReplyTo` is not refused.
- **E2E:** production bootstrap registers both verbs and their RBAC cases; with the gate on a
  standby's send returns the holder's verdict; with the gate off, today's 503.

## Maturation plan

- **test-agent-live:** a throwaway agent on two machines and a second agent: one send from a topic
  session on the standby and its reply, observed end to end.
- **dev-agent-live:** gate on for 48 hours on the development agent's own pool.
- **fleet:** flip `threadline.relayForward.enabled` fleet-wide after the graduation criterion holds.
- **graduation criterion:** one deliberate send from a named non-holder pool machine of the
  development agent, from a topic-bound session, to a named peer agent, with all of these observed:
  the `[a2a-forward]` line on the sender; the tracker row on the holder through
  `GET /threadline/peers/health?scope=pool`; the peer's reply appearing in the sending topic's
  session; and one fallback (owner session not alive → Telegram post, nothing spawned). Zero fails:
  if any one of the four is missing, the criterion is not met.
- **dark-window:** at most 7 days from merge to the fleet decision. If the criterion is not met
  then, the reason and a new date go on ACT-052; it is never left dark silently.

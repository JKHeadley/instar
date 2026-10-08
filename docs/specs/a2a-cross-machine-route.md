---
title: A2A cross-machine route — forward a send to my machine that holds the relay
slug: a2a-cross-machine-route
date: 2026-10-08
author: echo
status: draft
parent-spec: a2a-backup-routes.md
depends-on: a2a-honest-delivery-outcomes.md
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "A machine whose relay connection was taken by my other machine answers 'not connected' although the agent is connected. The send is handed to the machine that really holds the connection, and that machine's real verdict is returned."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "Capacity Safety — No Unbounded Self-Action", "Ownership-Gated Side Effects"]
eli16-overview: a2a-cross-machine-route.eli16.md
---

# Spec — A2A cross-machine route

When this machine cannot use the relay (its connection is down, or it is a standby) and another of
my own machines holds the connection, a send is
forwarded once to that machine over the existing signed mesh. That machine does the ordinary relay
send. No public endpoint, no new keys, no timer and no re-send are added. The *holder* is my machine
whose relay client is `connected`; the *forwarder* is one that cannot send over the relay itself.

## Problem

Evolution action ACT-052: when the relay cannot be used there is no other route. This agent's relay
event log (`logs/threadline-relay-events.jsonl`, 2026-08-19 to 2026-10-08, 80 events) shows what
actually breaks: 29 displacements ("Another device connected with the same identity key"), 11 own
restarts, 11 unexplained drops, and 1 relay server shutdown. In a displacement the agent is still
on the relay, on another of my machines, yet every send from the displaced machine answers 503. One
such episode lasted 6 h 45 min (`src/threadline/ThreadlineEndpoints.ts:262-266`). A standby machine
is in the same position all the time: it never connects, so its sends always answer 503.

## What exists (verified at `main` 890f02396)

| Fact | Code |
|---|---|
| relay-send answers 503 when the relay client is absent or not `connected`. The message id and thread are already minted by then. | `src/server/routes.ts:36677-36680`, `:36163`, `:36167` |
| The relay client is created only when the relay is wanted and this machine is not a standby. So it is **absent** when the relay is off by config and on a standby; health then reports `not-configured`. | `src/threadline/ThreadlineBootstrap.ts:175-180`, `:253-262`; `src/threadline/ThreadlineEndpoints.ts:155-157` |
| A standby is a machine with `multiMachine.telegramPolling: false`. The bootstrap is told so at boot; the route context is not. | `src/lifeline/telegramPollOwnership.ts:28-30`; `src/commands/server.ts:18081`; `src/threadline/ThreadlineBootstrap.ts:60` |
| When the listener daemon owns the relay, the client is **present** but never connects. The route context can already read that state. | `src/threadline/ThreadlineBootstrap.ts:189`, `:233-240`, `:287`, `:427`; `src/commands/server.ts:18102` |
| `banSuspected` is true after the relay sent a ban frame. | `src/threadline/client/ThreadlineClient.ts:868` |
| A signed, recipient-bound, replay-safe RPC exists between my own registered machines. It returns a typed result. The command body is inside the signature. | `src/core/MeshRpc.ts:270-274`, `:312-324`, `:577`; `src/server/routes.ts:21657`; `src/core/MeshRpcClient.ts:45-64` |
| One verb already carries agent-to-agent text between my machines, in the registered-peer class, with a caller-side `meshClient.send` and a per-peer URL resolver. | `src/core/MeshRpc.ts:43-51`, `:465-470`; `src/commands/server.ts:23466-23480`, `:23851-23857`, `:23947-23958` |
| `MessageRouter`'s cross-machine forward delivers stored envelopes to a target machine. It is not an outbound relay send. | `src/messaging/MessageRouter.ts:588-622` |
| Every server reports its relay state on the unauthenticated `/threadline/health`. No heartbeat field carries it. | `src/threadline/ThreadlineEndpoints.ts:253-275` |
| After a relay send the route writes, in order: reply waiter, tracker row, thread leg, origin capture, a 3-second verdict wait, outbox entry, bridge mirror and reply-claim release. | `src/server/routes.ts:36748-36751`, `:36760-36767`, `:36779-36790`, `:36794`, `:36800`, `:36811-36828`, `:36855-36866` |

**The mesh can carry this.** What is missing is listed under Design, "Build items".

## Threat model

Only my own registered machines can send the verb: the envelope is signed by the sender machine,
bound to the recipient and nonce-guarded. A compromised machine of mine can already speak as the
agent, so the verb adds no authority. The message body crosses between my machines signed but not
encrypted by the mesh. Tailscale and Cloudflare ropes encrypt in transit; a LAN rope is plain
`http://` (`src/core/MeshUrlAdvertiser.ts:260-263`). The existing `a2a-inbox-deliver` verb carries
text the same way. Credential sends are not forwarded.

## Design

### 1. Trigger

At the 503 point (`routes.ts:36677`), a forward is tried only when all of these hold:

- this machine cannot send over the relay for one of two reasons: **(a)** its relay client is
  present, not `connected`, not `banSuspected`, and the daemon does not own the relay; or **(b)**
  its relay client is absent because this machine is a standby;
- the send is not a credential share (`isCredentialShareSend`) and is not itself a forwarded one;
- one of my active peer machines reports `relay.state: 'connected'`.

Still today's 503: the relay is off by config, the daemon owns the relay, or a ban is suspected.

**The standby signal.** Case (b) is `relaySuppressedByStandby`: the value `relayWanted &&
config.relayStandby` that the bootstrap computes at `ThreadlineBootstrap.ts:175-180`. It is not on
the route context today. The bootstrap result gains this boolean and it is threaded onto the route
context beside `threadlineRelayClient`. The route must not recompute it from live config: the
client's absence was decided at boot, and "wanted" also depends on an environment variable. The
daemon case is read from the existing `inboundIdLedgerDaemonDeferred` getter (`server.ts:18102`).

The last condition is read from each active peer's `/threadline/health` over its mesh URL (2-second
timeout, at most 8 peers). It only picks the target. If no peer reports `connected`: today's 503.

### 2. Forward, and the holder sends

The forwarder sends one new mesh verb, `a2a-relay-forward`, to the first such peer:
`{ targetAgent, message, threadId, messageId, originTopicId?, purpose?, inReplyTo? }`, with the id
and thread this request already minted. One attempt, 15-second timeout, no retry. The verb is in the
registered-peer class, like `a2a-inbox-deliver`.

**Build items.** (1) The new mesh verb `a2a-relay-forward` in the `MeshCommand` union and its RBAC
case. (2) Its handler, registered beside `a2a-inbox-deliver`. (3) The relay-send body after
`routes.ts:36677`, lifted out of the route closure into one function that the route and the handler
both call. (4) `relaySuppressedByStandby` threaded from the bootstrap to the route context.

The holder's handler first checks its own relay client. If it is absent or not `connected`, it answers
`{ forwarded: false, reason: 'not-holder' }` and sends nothing. Otherwise it runs the ordinary
relay-send path with the given id and thread, marked forwarded, with `waitForReply` off. Every gate
on that path runs on the holder as for a local send. Gates therefore run twice, on the forwarder
before the 503 point and on the holder. This is intended, and the holder's verdict wins. A forwarded
request is never forwarded again.
The handler returns the route's own status and answer body.

### 3. The answer

| Holder's result | Forwarder answers |
|---|---|
| A relay verdict (`delivered`, `queued`, `rejected`) or any gate refusal | the holder's status and body, plus `deliveryPath: 'relay-via-machine'` and `forwardedTo: <machine nickname>` |
| `not-holder`, `no-handler` (an older peer), or a connection refused | today's 503 |
| Mesh timeout or any other transport error | 200, `relayStatus: 'unconfirmed'`, `forwardedTo`; the holder may have sent |

A refusal from the holder is returned as that refusal. Nothing is retried on another machine.

### 4. Bookkeeping: the holder is the single writer

The holder writes the tracker row, thread leg, origin capture, outbox entry and bridge mirror,
because its ordinary relay-send path does. The forwarder writes none of them. It writes one log
line, `[a2a-forward] id=<messageId> to=<machine> outcome=<outcome>`, and bumps a counter on the
authed `/health`. Delivery state for a forwarded send is read on the holder, or from any machine
through `GET /threadline/peers/health?scope=pool`. `waitForReply` cannot be honoured: the forwarder
answers `reply: null` with `replyArrivesOn: <machine nickname>`. A reply claim (`inReplyTo`) is
released by the forwarder on a 2xx answer and by its finish handler otherwise, as on the relay path.

**Replies: the residual.** A peer's reply reaches the holder, not the forwarder, and nothing routes it back to the sending
session. The holder treats it as any inbound message on that thread: with `originTopicId`, the
existing topic linkage shows it in that Telegram topic; otherwise it goes to the Threadline hub.
`GET /threadline/conversations?scope=mesh` names the holder (`src/server/routes.ts:17649-17661`).

## What it does not do

- No direct route to a different agent's machine. The log shows 1 relay-server outage in 7 weeks,
  so that stays a separate, evidence-gated item: ACT-065 (due 2026-10-22).
- It does not act when the relay is off by config, when the daemon owns the relay, or after a ban.
- It does not forward credentials, retry, queue, run in the background, or route a reply back (§4).

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| When a forward is tried | invariant | The conditions of §1; code decides. |
| Whether the holder sends | invariant | Its own client is `connected` at handling time; else `not-holder`. |
| What the caller is told | invariant | The table in §3; the holder's verdict is transcribed, never upgraded. |
| Who records the send | invariant | The holder only (§4). |

## Multi-machine posture

- **Unified.** The feature makes two of my machines act as one agent on the relay. It stores
  nothing new. Send records live where the send happened and are read through the existing pool read.
- **Ownership at fire time.** The holder acts only while it holds the relay connection, checked
  when the verb is handled. The health read on the forwarder only chooses a target.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| Client present, state not `connected` | This machine cannot send now | Read in the same request; daemon getter false | None |
| `relaySuppressedByStandby` | The client is absent because this machine is a standby | Set once at boot by the code that skipped creating the client | False → today's 503 |
| Peer health `relay.state: 'connected'` | That machine holds the relay | The holder's own check when it handles the verb | Stale or wrong → `not-holder` → 503 |
| Mesh result with a relay verdict | The holder's relay answered for this id | The verdict is keyed by `messageId` on the holder | No result → `unconfirmed` |
| `banSuspected` | The relay refused this agent | Set only by a ban frame | None |

## Frontloaded Decisions

1. **Forward when a peer holds the relay and this machine is displaced, disconnected or a standby.**
2. **The holder is found by reading each peer's `/threadline/health`; its own check is the authority.**
3. **One attempt, 15 seconds, no retry; a timeout is reported `unconfirmed`.**
4. **The holder is the single writer of all send records.**
5. **Credential sends are not forwarded; ordinary bodies cross the signed mesh unencrypted by it.**
6. **`waitForReply` answers `reply: null`; a reply stays on the holder.**
7. **Dev-gated under `threadline.relayForward`.**

## Open questions

*(none)*

## Configuration

`threadline.relayForward`: `{ enabled?: boolean }`, read live on both sides. `enabled` is omitted
from defaults, so `resolveDevAgentGate` decides (live on a development agent, dark on the fleet),
with a `DEV_GATED_FEATURES` entry. With the gate off the handler answers `not-holder`.

## Migration parity

- `ConfigDefaults`: none (`enabled` omitted on purpose). No new files or stored state.
- One new mesh verb; an older peer answers `no-handler`, which reads as today's 503.
- New counters on the authed `/health`; additive answer fields `forwardedTo`, `replyArrivesOn`.
- CLAUDE.md template section, added by `migrateClaudeMd()` (sniff key `A2A relay forward`).

## Rollback

`threadline.relayForward.enabled: false`, read live, restores today's 503. Nothing is stored.

## Agent awareness

Template + migrator section (`### A2A relay forward`): "When this machine's relay connection is
down, or it is a standby, and another of my machines holds the relay, a send is forwarded there and
sent over the relay. `deliveryPath: 'relay-via-machine'` and `forwardedTo` say so; `relayStatus` is that
machine's real verdict. The reply arrives on that machine, not in this session: `reply` is null and
`replyArrivesOn` names it. **When to use** (PROACTIVE): I am waiting on a reply to a forwarded send
→ read `GET /threadline/conversations?scope=mesh` and the thread on that machine; do not resend."

## Tests

- **Unit:** both sides of each §1 condition (connected, ban-suspected, daemon-owned, standby, relay
  off by config, credential, already forwarded, no connected peer); the §3 table, including a holder `rejected` returned as 502
  and a timeout returned `unconfirmed`; the handler's `not-holder` answer; no re-forward.
- **Integration:** two real servers of one agent and a real RelayServer. The forwarder is displaced;
  a send reaches a third agent once, with the forwarder's id and thread; the same from a standby; the tracker row, outbox
  entry and thread leg exist on the holder only. Holder disconnected, or no verb on the peer → 503.
- **E2E:** production bootstrap registers the `a2a-relay-forward` handler and RBAC case; with the
  gate on a forwarded send returns the holder's verdict; with the gate off, today's 503.

## Maturation plan

- **test-agent-live:** a throwaway agent on two machines: send from the standby, then displace one
  and send from it; observe each forwarded with the holder's verdict, records on the holder only.
- **dev-agent-live:** gate on for 48 hours on the development agent's own pool.
- **fleet:** flip `threadline.relayForward.enabled` fleet-wide after the graduation criterion holds.
- **graduation criterion:** at least 1 forwarded send observed from a standby or a displaced
  machine on the development agent's own pool:
  an `[a2a-forward]` line on the forwarder and the matching tracker row on the holder. Zero fails.
- **dark-window:** at most 7 days from merge to the fleet decision. If the count is still zero
  then, the reason and a new date go on ACT-052; it is never left dark silently.

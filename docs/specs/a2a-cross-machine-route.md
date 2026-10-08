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
is forwarded once to that machine over the existing signed mesh, and replies come back the same way.

**Principle: the holder is only a pipe.** The conversation stays on the machine that sent the
message. The *holder* is my machine whose relay client is `connected`. The *owner* is the machine
that sent the message and owns the conversation. A *rope* is one network path between two of my
machines (Tailscale, LAN or Cloudflare).

## Problem

Evolution action ACT-052: a machine of mine that does not hold the relay connection cannot send to
other agents. Its sends answer 503. The live case is a standby, or any pool machine that is not the
holder: it never connects, so this happens on every send.

The relay event log (`logs/threadline-relay-events.jsonl`, 2026-08-19 to 2026-10-08, 80 events) has
29 displacements, 11 own restarts, 11 unexplained drops and 1 relay server shutdown. The
displacement evidence is stale: 28 of the 29 were in August and the last was 2026-09-05. A displaced
client now reclaims its connection after 15 minutes (`src/threadline/ThreadlineBootstrap.ts:376-394`).

**Why forward and not reconnect.** The relay admits one connection per agent identity. A non-holder
that connected would displace the holder, and the two would trade the connection back and forth.

## What exists (verified at `main` 890f02396)

| Fact | Code |
|---|---|
| relay-send answers 503 when the relay client is absent or not `connected`. The message id, thread and nickname resolution exist by then. | `src/server/routes.ts:36677-36680`, `:36163`, `:36167`, `:36088-36160`, `:36689-36691` |
| The relay client is created only when the relay is wanted and this machine is not a standby. A standby is `multiMachine.telegramPolling: false`. The bootstrap knows this at boot; the route context does not. | `src/threadline/ThreadlineBootstrap.ts:175-180`, `:253-262`, `:60`; `src/commands/server.ts:18081`; `src/lifeline/telegramPollOwnership.ts:28-30` |
| When the listener daemon owns the relay, the client is present but never connects. The route context can read that. | `src/threadline/ThreadlineBootstrap.ts:189`, `:233-240`, `:287`; `src/commands/server.ts:18102` |
| `banSuspected` is true after a ban frame. `send` throws `Not connected` without a relay client. | `src/threadline/client/ThreadlineClient.ts:868`, `:318`, `:361` |
| A signed, recipient-bound, replay-safe RPC exists between my own machines. It returns a typed result; an unknown verb answers `claim-unauthorized`. Late-bound senders call it from routes. | `src/core/MeshRpc.ts:270-274`, `:312-324`, `:499-500`, `:577`; `src/commands/server.ts:23851-23857`, `:23947-23958` |
| `a2a-inbox-deliver` is **not** a Threadline carrier. It accepts only a known mentor's machine, requires a mentor marker in the text, and dispatches into the Telegram mentor hook. | `src/core/A2aMeshInbox.ts:23-52`; `src/commands/server.ts:23466-23480` |
| Every server reports `relay.state` and `fingerprint` on the unauthenticated `/threadline/health`. No heartbeat carries them. | `src/threadline/ThreadlineEndpoints.ts:253-275` |
| A relay reply enters one handler after the ledger commit. That handler lives inside the relay-client block and uses the client for the auto-ack. | `src/commands/server.ts:18224-18243`, `:18267`, `:18296-18300` |
| On a machine with no local session for the thread, topic linkage reports the topic expired and the message is then processed normally. | `src/threadline/TopicLinkageHandler.ts:343-347`, `:368-378`; `src/commands/server.ts:18292-18294` |
| The delivery tracker has one row per message id, with the thread id, and is never pruned. Relay verdicts arrive on the connection that sent. | `src/threadline/A2ADeliveryTracker.ts:122-128`, `:262-277` |
| The ledger's hand-off paths are a fixed allowlist. | `src/threadline/InboundIdLedger.ts:44-55` |
| Send results reach agents through `SendMessageResult` and the MCP tool. | `src/threadline/ThreadlineMCPServer.ts:133-149`, `:681` |

## Threat model

Only my own registered machines can send the two new verbs: each envelope is signed by the sender
machine, bound to the recipient and nonce-guarded. A compromised machine of mine can already speak
as the agent, so the verbs add no authority. Message bodies cross between my machines signed but not
encrypted by the mesh. Tailscale and Cloudflare ropes encrypt in transit; a LAN rope is plain
`http://` (`src/core/MeshUrlAdvertiser.ts:260-263`). This is accepted for ordinary messages.
Credential sends are refused on the owner and never cross. The holder cannot re-check that: the
credential label is a caller hint, and the holder sees only a body.

## Design

### 1. Trigger (outbound)

At the 503 point (`routes.ts:36677`) a forward is tried only when all of these hold:

- this machine cannot send for one of two reasons: **(a)** its relay client is present, not
  `connected`, not `banSuspected`, and the daemon does not own the relay; or **(b)** its client is
  absent because it is a standby (`relaySuppressedByStandby`, the boot-time value `relayWanted &&
  config.relayStandby`, threaded from the bootstrap to the route context; never recomputed from live
  config);
- the send is not a credential share (`isCredentialShareSend`);
- a holder is found.

**Finding the holder.** The owner reads `/threadline/health` from its active peer machines in
parallel (at most 8, 2 seconds in total). A peer qualifies when `relay.state === 'connected'` and
its `fingerprint` equals this machine's own fingerprint. The first that qualifies is the target. The
holder's own check is the authority. Otherwise the answer is today's 503: relay off by config,
daemon-owned relay, ban, or no holder.

### 2. The owner does everything except the relay send

The owner runs every gate and all conversation bookkeeping, exactly as for a normal send: reply
claim, negotiator lease, credential refusal, reply waiter, thread leg, origin capture, outbox entry
(its outcome comes from the holder's verdict) and claim release. `originTopicId` and `purpose` stay
on the owner. Records that need the peer's fingerprint use the owner's own resolution when it has
one; otherwise they are written when the holder's answer returns `resolvedAgent`.

It sends one mesh verb, `a2a-relay-forward`: `{ targetAgent, resolvedFp?, body, messageId,
threadId, resend, ownerMachineId }`. `resolvedFp` is the owner's own resolution, so the holder
cannot address a different agent. `threadId` is `effectiveThreadId`. `resend` is
`classifyFallthrough(localPostOutcome).marked` (backup routes §1). One attempt, 15 seconds, no retry.
The whole route adds at most 17 seconds.

### 3. The holder is a pipe

The handler calls only the lifted relay-execution function, `(deps, input) → { status, body }`,
wired by a late-bound reference like `_deliverA2aToMachine`. That function resolves the target (only
when `resolvedFp` is absent), sends over the relay, waits up to 3 seconds for the relay's verdict,
writes the tracker row with a new `forwarded_from` column set to `ownerMachineId`, and returns the
verdict and `resolvedAgent`. It runs no gate and writes no thread leg, origin capture or outbox
entry. The handler never reaches the §1 trigger, so a forwarding loop cannot occur.

### 4. The answer

- **Provably not sent → today's 503.** Any typed dispatcher rejection (`ok: false` with a reason,
  including `claim-unauthorized` from an older peer, `stale-timestamp`, `replayed-nonce`,
  `unknown-sender`, and the 503 "mesh-rpc not configured"); a refused connection; the gate off on
  the holder; a holder that is not connected or loses the relay mid-send (`Not connected`).
- **A relay verdict** → the same answer a local send gives for that verdict (`rejected` is 502),
  plus `deliveryPath: 'forwarded'` and `forwardedTo: <machine nickname>`.
- **A timeout or a non-200 with no reason → `relayStatus: 'unconfirmed'`**, with the `messageId`
  and the text "do not resend; check delivery on <machine>". A caller that retries anyway mints a
  new id, as with today's `unconfirmed`.

`SendMessageResult` and the MCP tool rendering carry `deliveryPath`, `forwardedTo` and
`relayStatus`, with an MCP contract test beside the honest-delivery one.

### 5. Replies come back mechanically

On the holder's inbound relay path, after the gate and the inbound-id ledger commit, the holder
looks up the newest tracker row for that thread and sender. If its `forwarded_from` names another
machine, the holder:

- records the implicit delivery ack on its tracker row, which lives there;
- hands the message to that machine with a second new verb, `a2a-relay-inbound`: `{ from, threadId,
  messageId, content, timestamp, reason, trustLevel }`;
- sends no auto-ack, does not route locally and does not spawn;
- records the ledger disposition `handed-off` with a new path `mesh` (not durable).

The owner's handler runs the same two steps the relay path runs (`runRelayInboundWithLedger`, then
`handleGatePassedRelayMessage`), with the sender key the holder used. Topic linkage and the reply
waiter then work locally, so `waitForReply` is honoured. No auto-ack is sent for such a message: the
owner has no relay connection.

If the owner is unreachable or rejects the verb, the holder falls back to today's local handling and
marks it with one log line and a counter. A message is never dropped.

An inbound auto-ack on such a thread is recorded on the holder's tracker row and not forwarded.
Acks are never acked and never spawn (ACT-063, in flight).

### Build items

1. Verbs `a2a-relay-forward` and `a2a-relay-inbound` in `MeshCommand`, each with a registered-peer
   RBAC case and a handler.
2. The relay-execution steps after `routes.ts:36677` lifted into one function used by the route and
   the handler; the owner-side bookkeeping stays in the route.
3. `handleGatePassedRelayMessage` lifted out of the relay-client block so it runs on a machine with
   no relay client, with the auto-ack skipped there.
4. `relaySuppressedByStandby` threaded from the bootstrap to the route context.
5. Tracker column `forwarded_from`; ledger path `mesh`; the result fields and MCP rendering.

Log lines: `[a2a-forward] id=<messageId> dir=out|in peer-machine=<machine> outcome=<outcome>`, with
counters on the authed `/health`.

## What it does not do

- No direct route to a different agent's machine. The log shows 1 relay-server outage in 7 weeks, so
  that is a separate, evidence-gated item: ACT-065 (due 2026-10-22).
- It does not act when the relay is off by config, when the daemon owns the relay, or after a ban.
- It does not forward credentials, retry, queue or run in the background.

**Residuals.** The negotiator lease is per machine, so two of my machines can each hold the voice
for one conversation. The owner's thread log stamps its own send time, so thread symmetry reads
`unverified` for a forwarded leg, as it does on the relay path today.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| When a forward is tried | invariant | The conditions of §1; code decides. |
| Whether the holder sends | invariant | Its own client is `connected` at handling time. |
| What the caller is told | invariant | §4; the holder's verdict is transcribed, never upgraded. |
| Where an inbound message is handled | invariant | The newest tracker row's `forwarded_from`; on any failure, local handling. |

## Multi-machine posture

- **Unified.** Conversation records (thread log, origin capture, outbox, topic linkage, session)
  live on the owner. The delivery tracker row lives on the holder, where relay verdicts arrive, and
  is read from any machine through `GET /threadline/peers/health?scope=pool`.
- **Ownership-Gated Side Effects.** The holder performs no topic-scoped side effect: it relays
  bytes and writes a tracker row.
- **No manual work.** Replies return by code. No agent instruction is needed.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| Client present, not `connected` | This machine cannot send now | Read in the same request; daemon getter false | None |
| `relaySuppressedByStandby` | The client is absent because this machine is a standby | Set at boot by the code that skipped creating the client | False → 503 |
| Peer health `connected` + own fingerprint | That machine holds my relay connection | The holder's own check when it handles the verb | Wrong → typed refusal → 503 |
| Typed mesh rejection | The holder sent nothing | The dispatcher rejects before the handler runs | No reason given → `unconfirmed` |
| Tracker `forwarded_from` | The conversation lives on that machine | Written by the holder when it sent for that machine | No row → local handling |

## Frontloaded Decisions

1. **Forward when this machine is a standby, disconnected or displaced, and a peer holds the relay.**
2. **The owner runs all gates and conversation records; the holder only sends and tracks delivery.**
3. **The holder is found by a parallel health read that must match my own fingerprint.**
4. **One attempt; a typed rejection is 503; only a timeout is `unconfirmed`.**
5. **Replies return over a new verb, keyed by the tracker row; failure falls back to local handling.**
6. **`a2a-inbox-deliver` is not reused; it is the mentor carrier.**
7. **Dev-gated under `threadline.relayForward`.**

## Open questions

*(none)*

## Configuration

`threadline.relayForward`: `{ enabled?: boolean }`, read live on both sides. `enabled` is omitted
from defaults, so `resolveDevAgentGate` decides (live on a development agent, dark on the fleet),
with a `DEV_GATED_FEATURES` entry.

## Migration parity

- `ConfigDefaults`: none (`enabled` omitted on purpose).
- Tracker: additive nullable column `forwarded_from`. Ledger: one new hand-off path, `mesh`.
- An older peer answers `claim-unauthorized` for either verb. Outbound that is today's 503; inbound
  it is local handling.
- Additive result fields `deliveryPath: 'forwarded'` and `forwardedTo`; new `/health` counters.
- CLAUDE.md template section, added by `migrateClaudeMd()` (sniff key `A2A relay forward`).

## Rollback

`threadline.relayForward.enabled: false`, read live, restores today's 503 and local handling of
every inbound message. The new column and ledger path are inert.

## Agent awareness

Template + migrator section (`### A2A relay forward`): "When this machine does not hold my relay
connection and another of my machines does, my sends go out through that machine and replies come
back to this session as usual. `deliveryPath: 'forwarded'` and `forwardedTo` say so; `relayStatus`
is the real relay verdict. `unconfirmed` means unknown: I do not resend. **When to use**
(PROACTIVE): a user asks why a send from a standby machine now works, or which machine carried a
message → read `forwardedTo` and `GET /threadline/peers/health?scope=pool`."

## Tests

- **Unit:** both sides of each §1 condition (connected, ban, daemon-owned, standby, relay off,
  credential, no holder, wrong fingerprint); each §4 class, including `claim-unauthorized` → 503 and
  a timeout → `unconfirmed`; the inbound rule (row names another machine, names self, no row, owner
  rejects → local); an auto-ack is not forwarded; the MCP contract test.
- **Integration:** two real servers of one agent, a real RelayServer and a third agent. A send from
  the standby arrives once with the owner's id and thread; the thread leg and outbox entry exist on
  the owner only and the tracker row on the holder only; the reply reaches the owner's session and
  resolves `waitForReply`; the holder spawns nothing. Owner stopped → the reply is handled locally
  and marked.
- **E2E:** production bootstrap registers both verbs and their RBAC cases; with the gate on a
  standby's send returns the holder's verdict; with the gate off, today's 503.

## Maturation plan

- **test-agent-live:** a throwaway agent on two machines and a second agent: one send from the
  standby and its reply, observed end to end.
- **dev-agent-live:** gate on for 48 hours on the development agent's own pool.
- **fleet:** flip `threadline.relayForward.enabled` fleet-wide after the graduation criterion holds.
- **graduation criterion:** one deliberate Threadline send from a named non-holder pool machine of
  the development agent to a named peer agent, with all three observed: the `[a2a-forward] dir=out`
  line on that machine; the tracker row through `GET /threadline/peers/health?scope=pool`; and a
  reply that arrives in the sending session. Zero fails: if any of the three is missing, the
  criterion is not met.
- **dark-window:** at most 7 days from merge to the fleet decision. If the criterion is not met
  then, the reason and a new date go on ACT-052; it is never left dark silently.

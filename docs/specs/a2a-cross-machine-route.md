---
title: A2A cross-machine route — a standby forwards its sends to my machine that holds the relay
slug: a2a-cross-machine-route
date: 2026-10-08
author: echo
status: draft
parent-spec: a2a-backup-routes.md
depends-on: a2a-honest-delivery-outcomes.md
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "A standby machine of mine answers 'not connected' although the agent is connected. The send goes out through the machine that holds the connection, and that machine's real verdict comes back."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "Capacity Safety — No Unbounded Self-Action", "Ownership-Gated Side Effects"]
eli16-overview: a2a-cross-machine-route.eli16.md
---

# Spec — A2A cross-machine route

A standby machine of mine forwards a send once, over the existing signed mesh, to my machine that
holds the relay connection. That machine runs the complete ordinary relay-send route and owns the
records, as it does for its own sends. A reply on a thread bound to a Telegram topic is typed into
that topic's live session on whichever of my machines has it. Any failure degrades to behaviour
that exists today.

**Glossary.** *Holder*: my machine whose relay client is `connected`. *Standby*: a machine of mine
with `multiMachine.telegramPolling: false`; it never connects to the relay. *Rope*: one network path
between two of my machines (Tailscale, LAN or Cloudflare). *Dark*: a feature that is built but off.
*Negotiator gate*: the per-conversation check that only one of my sessions speaks. *Warm-reply
rule*: a session bound to a thread must name the inbound message it answers. *Redrive engine*: a
job that re-sends for open reply commitments.

## Problem

Evolution action ACT-052: a standby cannot send to other agents. It has no relay client, so every
send answers 503. In an active-active pool sessions run on standbys, and each send they make fails.

The relay event log (`logs/threadline-relay-events.jsonl`, 2026-08-19 to 2026-10-08, 80 events) has
29 displacements, 11 own restarts, 11 unexplained drops and 1 relay server shutdown. Displacement
is not the live case: 28 of the 29 were in August and the last was 2026-09-05.

**Why forward.** The relay admits one connection per agent identity, so a standby that connected
would displace the holder. Letting the relay accept several connections per identity is a relay
protocol change with its own delivery fan-out problem, and is out of scope.

## What exists (verified at `main` 890f02396)

| Fact | Code |
|---|---|
| relay-send answers 503 when the relay client is absent or not `connected`. The message id and nickname resolution exist by then. | `src/server/routes.ts:36677-36680`, `:36163`, `:36084-36160` |
| The relay client is not created on a standby. The bootstrap knows this at boot; the route context does not. | `src/threadline/ThreadlineBootstrap.ts:175-180`, `:253-262`; `src/commands/server.ts:18081` |
| A displaced client reclaims the connection after 15 minutes, so two owners trade it. | `src/threadline/ThreadlineBootstrap.ts:376-394` |
| Three checks are keyed on `inReplyTo` or `originSessionName`: the warm-reply rule, the authenticated-inbound rule and the reply claim. The session-to-topic lookup is local to the sending machine. | `src/server/routes.ts:35904-35925`, `:36018-36021`; `src/threadline/ThreadlineReplyValidation.ts:30-44` |
| The relay leg uses the caller's raw thread id unless a local POST was issued. The verdict wait is keyed on the message id. The thread-log author is this machine's id. | `src/server/routes.ts:36733`, `:36789`, `:36799` |
| A reply counts as settled when the outbox has an entry for its `inReplyTo` that is not `relay-rejected`; reap recovery re-drives otherwise. | `src/threadline/ListenerSessionManager.ts:283-298`; `src/threadline/ThreadlineReapRecovery.ts:79-100` |
| A signed, recipient-bound, nonce-guarded RPC exists between my own machines, with a registered-peer class. An unknown verb answers `claim-unauthorized`. | `src/core/MeshRpc.ts:30-51`, `:312-324`, `:462-470`, `:499-500`; `src/commands/server.ts:23466-23480`, `:23947-23958` |
| Every server reports `relay.state` and `fingerprint` on the unauthenticated `/threadline/health`. | `src/threadline/ThreadlineEndpoints.ts:253-275` |
| Origin capture writes the thread's topic, keeps a `machineOrigin` field, and records a reply commitment whose `relatedAgent` is the display name. The inbound envelope's sender is the fingerprint. | `src/threadline/TopicLinkageHandler.ts:236-251`, `:277-296`; `src/threadline/ThreadResumeMap.ts:44`; `src/commands/server.ts:18485` |
| On a reply, topic linkage compares the sender with `relatedAgent`, then needs a local session or resume entry; without one the router falls through to the thread worker. | `src/threadline/TopicLinkageHandler.ts:341-347`, `:355-378`; `src/threadline/ThreadlineRouter.ts:714-717` |
| A failed inject is `failure-visible`, which posts the reply into the Telegram topic, subject to a per-thread and a per-topic rate limit. Any `routed` outcome returns `handled: true` before a spawn. | `src/threadline/TopicLinkageHandler.ts:120`, `:142-143`, `:462-485`; `src/threadline/ThreadlineRouter.ts:700-711` |
| A confirmed inject reports whether the session consumed the text (up to 7.5 seconds). A long reply is truncated with a pointer to `threadline_history`. | `src/core/SessionManager.ts:6880-6902`; `src/threadline/TopicLinkageHandler.ts:597` |
| The ownership registry answers `ownerOf(String(topicId))`. | `src/core/SessionOwnershipRegistry.ts:157`; `src/server/routes.ts:24485` |
| A same-id resend after a non-durable hand-off is delivered on purpose, with a notice. | `docs/specs/a2a-inbound-id-ledger.md:36-41`, `:178` |

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

- the relay client is absent because this machine is a standby (`relaySuppressedByStandby`: the
  boot-time value `relayWanted && config.relayStandby`, threaded from the bootstrap to the route
  context, never recomputed from live config);
- the send is not a credential share (`isCredentialShareSend`);
- a holder is found.

**Finding the holder.** The sender reads `/threadline/health` from its active peer machines in
parallel (at most 8, 2 seconds in total). A peer qualifies when `relay.state === 'connected'` and
its `fingerprint` equals this machine's own. The forward goes over the URL that answered. The answer
is cached in memory for 60 seconds and dropped on any forward failure. The holder's own check is the
authority. With no holder the answer is today's 503.

### 2. Forward

The sender has already run its own checks: the warm-reply rule, the authenticated-inbound rule, the
reply claim, the negotiator gate and the credential refusal. It sends one mesh verb,
`a2a-relay-forward`: `{ targetAgent, resolvedFp?, body, messageId, threadId?, resend,
originTopicId?, purpose? }`.

- `targetAgent` is forwarded unchanged, so names in the holder's records stay names. `resolvedFp`
  is the sender's own nickname resolution; the holder uses it and cannot re-resolve the name to a
  different agent. Without `resolvedFp` the holder resolves the name from its own nickname file and
  relay discovery (`routes.ts:36706`).
- `threadId` is `relayLegThreadId`: the caller's raw thread id, unless a local POST was issued. The
  records live on the holder, so the holder's resolver decides which thread a send with no thread id
  joins.
- `resend` is `classifyFallthrough(localPostOutcome).marked`.
- `originTopicId` is resolved by the sender, because that lookup is local to it.

One attempt, 15 seconds, no retry. With the 2-second holder probe, a forwarded send takes at most
about 17 seconds, inside one tool call. The mesh verb is used, not a
direct HTTP call to the holder's route, because the envelope gives signing, replay protection,
recipient binding and registered-peer RBAC.

### 3. The holder runs the ordinary route, by a loopback call

The handler POSTs to its own `POST /threadline/relay-send` on loopback. The route body is about a
thousand lines of closure state that writes the response as it goes; a loopback call reuses it
unchanged, and lifting it is a larger and riskier change for the same result (the lift is tracked
as ACT-068, due 2026-10-20). The call carries a
secret generated in memory at boot. The secret is never in the environment, config or logs, and is
compared with `timingSafeEqual`. A restart mid-flight makes the forward fail closed (503).

The body is `{ targetAgent, resolvedFp, message, threadId, originTopicId, purpose, waitForReply:
false, messageId, resend, forwardedFromMachine }`. `forwardedFromMachine` is the
authenticated mesh sender. `inReplyTo` and `originSessionName` are never sent.

| On the holder, for a forwarded request | |
|---|---|
| **Runs** | required fields and the 64 KiB limit; target resolution; the 503 guard on its own relay client; the relay send; tracker row; thread leg; origin capture and its commitment; the 3-second verdict wait; outbox entry; bridge mirror |
| **Skipped because the field is absent** | the warm-reply rule, the authenticated-inbound rule and the reply claim; the session-to-topic lookup; the reply wait |
| **Only when the secret matches** | the negotiator gate and the local-delivery branches are skipped; the §1 trigger never fires; `resolvedFp` is used as the nickname resolution; `messageId` and `resend` are honoured; `forwardedFromMachine` is stored as the thread's `machineOrigin` and as the thread-log author's machine |

A forwarded request always goes over the relay on the holder. So a holder 503 proves the forward
sent nothing, and a target that runs on the holder's machine is simply reached through the relay.
`machineOrigin` is overwritten on every forwarded capture (`input.machineOrigin ??
existing?.machineOrigin`; today the existing value is kept), so a topic that moved to a second
standby asks the right machine first.

**Loop stop.** The `a2a-relay-forward` handler refuses with a typed reason when its own machine has
`relaySuppressedByStandby`, and the §1 trigger never fires for a request that carries the secret.
Negotiator single-voice is not enforced across machines; the gate is dry-run today.

### 4. The answer

- **The forward did not execute → today's 503.** Any typed mesh rejection (`ok: false` with a
  reason, including `claim-unauthorized` from an older peer, `stale-timestamp`, `replayed-nonce`,
  `unknown-sender`, a standby refusing, and the 503 "mesh-rpc not configured"); a refused
  connection; the gate off on the holder; the holder's own 503. This proves only that the forward
  sent nothing. If the
  sender's own local POST was issued earlier, that attempt's uncertainty stands, and `resend`
  carries it.
- **Any other answer from the holder's route** → that status and body, unchanged: a relay
  `rejected` is 502, and every 4xx passes through (for example the ambiguous-nickname 409,
  `routes.ts:36116-36135`). Added: `deliveryPath: 'forwarded'`, `forwardedTo: <machine nickname>`, `reply: null`, and
  `replyArrivesIn`: `'topic-session'` when the send had a topic, else `'holder-hub'`.
- **A timeout or a non-200 with no reason → `relayStatus: 'unconfirmed'`**, with the `messageId` and
  "do not resend; check delivery on <machine>". A caller that retries anyway mints a new id, as with
  today's `unconfirmed`.

**The sender's records.** The sender writes one log line, `[a2a-forward] id=<messageId>
to=<machine> outcome=<outcome>`, and a counter on the authed `/health`. It writes no A2A record,
except one settlement line: when its own `inReplyTo` check passed and the holder sent, it calls
`appendCanonicalOutboxEntry` with `inReplyTo`, the request's own `threadId` (the one that check
validated, `routes.ts:35912-35915`) and the holder's outcome, so reap recovery does not re-drive an
answered message.

| Answer | Settlement line | Reply claim |
|---|---|---|
| 2xx with a relay verdict | holder's outcome | released |
| 502 refusal | none (stays re-drivable) | released by the finish handler |
| holder 4xx | none | released by the finish handler |
| 503, forward did not execute | none | released by the finish handler |
| timeout | `relay-unconfirmed` (settled: no duplicate over no loss) | released |

A standby session that names an `inReplyTo` it never received gets a 400 from its own
authenticated-inbound rule before the trigger. This is near zero in practice: inbound messages
arrive on the holder, and an injected reply carries no message id.

`SendMessageResult` and the MCP tool rendering carry the new fields, with an MCP contract test.

### 5. A reply reaches the topic's session on whichever machine has it

**Sender check fix.** The check at `TopicLinkageHandler.ts:355-364` compares the inbound
fingerprint with the commitment's display name, so it returns no-linkage for every name-addressed
send. It now also accepts a sender equal to the thread entry's `remoteAgent`, which is the resolved
fingerprint. The stored commitment is unchanged, because other readers use its name.

**Whom to ask.** After the sender check and before the topic-active test (`:366`), when the thread
has a topic and no local session for it is alive:

1. If the thread's `machineOrigin` names another machine, ask it.
2. Only if that answered a definitive `{ injected: false }`, and `ownerOf(String(topicId))` names a
   third machine, ask that one. A timeout or transport error on the first ask ends in
   `failure-visible` with no second ask, because the first may have landed.
3. With no `machineOrigin`, ask the machine `ownerOf` names, if it is not this one.

At most two asks, one after the other, inside one 12-second budget. Step 1 needs no ownership
record, so it works with the session pool dark. A stale `machineOrigin` after a holder-local send is
harmless: a live local session wins before any ask. The `ownerOf` read and each ask are wrapped; a
throw is `failure-visible`. Without that, the router would catch the throw and fall through to the
thread worker (`ThreadlineRouter.ts:715-719`).

Only the per-thread spawn lock is held while this runs (`ThreadlineRouter.ts:372`, `:627-638`).
Other threads are not blocked. The payload is built by the existing steps (`:386-405`); for a
remote inject its truncation line names the holder as the place to read the full body.

The ask is a second verb, `a2a-topic-reply-inject`: `{ topicId, text, messageId, threadId }`. The
receiver reads its own `getSessionForTopic(topicId)`. If that session is alive it calls
`injectPasteNotificationConfirmed` and answers `{ injected: true }`; otherwise `{ injected: false,
reason }`. It never spawns and never moves the topic. A replayed envelope is refused by the mesh
nonce guard (`MeshRpc.ts:321`), and each ask is one attempt.

**Outcome.** Injected → `deliveryMode: 'live-inject'`, and the existing commitment and no-Telegram
logic runs. Anything else (unreachable, no live session, older peer, timeout) → `failure-visible`:
the holder posts the reply into the Telegram topic, as it does today for a failed inject.

**Invariant.** Every outcome on this branch is `routed`, so the router returns `handled: true`
before any spawn. A topic-bound reply never spawns a context-less session on the holder.

**Today's code, unchanged.** A thread with no `machineOrigin` and no ownership record naming another
machine takes today's path. This is the only case that can still reach the thread worker, and it is
today's behaviour for a thread started on this machine.

**Accepted worst cases.** (1) An inject that timed out but landed is also posted to the Telegram
topic: a visible duplicate note, never a second processing by a session on the holder. (2) The
Telegram post is rate-limited (one per thread per minute, three per topic per minute). A second
reply inside that window while the other machine is unreachable is neither injected nor posted. It
stays in the holder's hub with the commitment open and no beacon. (3) A second reply on the same
thread that arrives while an ask is in flight is refused "Spawn already in progress"
(`ThreadlineRouter.ts:627-634`) and is not retried.

**A pre-existing case this fixes.** A message sent from topic T on machine A, after which T moved to
machine B: today the reply finds no local session on A. Step 3 reaches T's session on B.

## What it does not do

- No direct route to a different agent's machine. The log shows 1 relay-server outage in 7 weeks, so
  that is a separate, evidence-gated item: ACT-065 (due 2026-10-22).
- **A displaced or disconnected machine keeps today's 503.** A displaced client reclaims after 15
  minutes and two owners trade the connection. A thread recorded on the holder of the moment would
  be orphaned by the next flip, which leads to a context-less spawn. The evidence for this case is
  also stale.
- It does not forward credentials, retry, queue or run in the background.
- **A send with no topic** (a job, an unbound session): the reply lands on the holder like a
  holder-originated thread with no topic today. The sending session does not see it in-band.
- **`waitForReply` is not honoured across machines.** The answer is `reply: null` at once.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| When a forward is tried | invariant | The conditions of §1; code decides. |
| Which checks the holder runs | invariant | The table in §3; a skip needs an absent field or the boot secret. |
| What the caller is told and what is settled | invariant | §4; the holder's answer is transcribed, never upgraded. |
| Where a topic-bound reply is delivered | invariant | The receiver's own live session; else the Telegram post. |

## Multi-machine posture

- **Unified.** A2A records live on the holder, for forwarded sends and its own sends alike. This is
  the posture today; replicating them is ACT-054. They are read from any machine through the
  existing pool reads (`GET /threadline/peers/health?scope=pool`,
  `GET /threadline/conversations?scope=mesh`). Nothing new is stored: `machineOrigin` is an existing
  field.
- **Ownership-Gated Side Effects.** The only session-scoped side effect is the inject. The receiver
  authorises it from its own live session for that topic. A stale duplicate session for a topic is
  the duplicate-session reconciler's concern, not this spec's.
- **No manual work.** A topic-bound reply returns by code; no agent instruction is needed.
- **Residual.** A rate-limited reply stays in the holder's hub with its commitment open. Reply
  commitments have no beacon and the redrive engine ships off; all of this exists today.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| `relaySuppressedByStandby` | The client is absent because this machine is a standby | Set at boot by the code that skipped creating the client | False → 503 |
| Peer health `connected` + own fingerprint | That machine holds my relay connection | The holder's own 503 guard when it runs the route | Wrong → 503, cache dropped |
| Typed mesh rejection | The forward sent nothing | The dispatcher rejects before the handler runs | No reason → `unconfirmed` |
| Thread `machineOrigin` | That machine sent the message | Written from the authenticated mesh sender, under the boot secret | Absent → ownership record, else today's code |
| `ownerOf(String(topicId))` | That machine has the topic | The receiver's own session and liveness check | Stale or absent → Telegram post |
| `{ injected: true }` | The session consumed the reply | `injectPasteNotificationConfirmed` on the receiver | Timeout → Telegram post |

## Frontloaded Decisions

1. **Only a standby forwards. A displaced or disconnected machine keeps the 503.**
2. **The holder runs the complete ordinary route, entered by a loopback call marked with a boot secret.**
3. **Checks keyed on the sending session run on the sender only; `inReplyTo` is never forwarded.**
4. **One attempt; a forward that did not execute is 503; only a timeout is `unconfirmed`.**
5. **A reply is injected on the machine named by `machineOrigin`, then by the ownership record; any
   failure is a Telegram post; nothing is spawned on the holder for a topic-bound reply.**
6. **The sender check also accepts the thread entry's fingerprint.**
7. **Dev-gated under `threadline.relayForward`.**

## Open questions

*(none)*

## Configuration

`threadline.relayForward`: `{ enabled?: boolean }`, read live on every machine. `enabled` is
omitted from defaults, so `resolveDevAgentGate` decides (live on a development agent, dark on the
fleet), with a `DEV_GATED_FEATURES` entry. With the gate off both handlers refuse and no machine is
asked on a reply. The sender check fix is not gated.

## Migration parity

- `ConfigDefaults`: none (`enabled` omitted on purpose). No new files, columns or stored state.
- Two new mesh verbs. An older peer answers `claim-unauthorized`: for a forward that is today's 503;
  for an inject it is the Telegram post.
- Additive result fields `deliveryPath: 'forwarded'`, `forwardedTo`, `replyArrivesIn`; new counters.
- CLAUDE.md template section, added by `migrateClaudeMd()` (sniff key `A2A relay forward`).

## Rollback

`threadline.relayForward.enabled: false`, read live, restores today's 503 and today's topic linkage.
After that, a reply to a thread that was already forwarded finds no local session on the holder,
takes `topic-expired`, and spawns on the holder.

## Agent awareness

Template + migrator section (`### A2A relay forward`): "When this machine is a standby and another
of my machines holds my relay connection, my sends go out through that machine.
`deliveryPath: 'forwarded'` and `forwardedTo` say so; `relayStatus` is the real relay verdict, and
`unconfirmed` means unknown: I do not resend. `reply` is null. A reply to a send made from a topic
arrives in that topic's session; a reply to a send with no topic arrives on the machine named in
`forwardedTo`, in its Threadline hub. **When to use** (PROACTIVE): a user asks which machine carried
a message, or where a reply went → read `forwardedTo`, `replyArrivesIn` and
`GET /threadline/peers/health?scope=pool`."

## Tests

- **Unit:** both sides of each §1 condition (standby, not a standby, credential, no holder, wrong
  fingerprint, cache dropped after a failure); the §3 table, including a wrong or missing secret, a
  target co-located with the holder still going over the relay, and a standby handler refusing; each
  §4 class and its settlement and claim row; a standby `inReplyTo` it never
  received → 400; the sender check with a name-addressed target; the ask order of §5 (no second ask after a
  timeout); a throwing `ownerOf` or ask still returns `routed`; the receiver (alive, not alive;
  never spawns). "No `machineOrigin` and no record" asserts today's exact outcome.
- **Integration:** two real servers of one agent, a real RelayServer and a third agent addressed by
  name. A send from a topic session on the standby arrives once; all A2A records are on the holder;
  the reply is injected into the standby's session. Nothing is spawned on the holder for a
  topic-bound reply on every failure path: no ownership record, unreachable machine, an older peer
  answering `claim-unauthorized`, a timeout, a rate-limited post.
- **E2E:** production bootstrap registers both verbs and their RBAC cases; with the gate on a
  standby's send returns the holder's verdict; with the gate off, today's 503.

## Maturation plan

- **test-agent-live:** a throwaway agent on two machines and a second agent: one send from a topic
  session on the standby and its reply, observed end to end.
- **dev-agent-live:** gate on for 48 hours on the development agent's own pool.
- **fleet:** flip `threadline.relayForward.enabled` fleet-wide after the graduation criterion holds.
- **graduation criterion:** one deliberate send from a named standby of the development agent, from
  a topic-bound session whose topic has no ownership record, to a peer agent addressed by name, with
  all of these observed: the `[a2a-forward]` line on the sender; the tracker row on the holder
  through `GET /threadline/peers/health?scope=pool`; the peer's reply appearing in the sending
  topic's session; and one fallback post (session not alive → Telegram post, nothing spawned). Zero
  fails: if any one of the four is missing, the criterion is not met.
- **dark-window:** at most 7 days from merge to the fleet decision. If the criterion is not met
  then, the reason and a new date go on ACT-052; it is never left dark silently.

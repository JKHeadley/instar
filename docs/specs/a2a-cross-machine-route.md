---
title: A2A cross-machine route — a signed direct route to a listed peer when my relay is down
slug: a2a-cross-machine-route
date: 2026-10-08
author: echo
status: draft
parent-spec: a2a-backup-routes.md
depends-on: a2a-inbound-id-ledger.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "A second route to another agent is only safe if both ends prove who they are with their own keys, with no relay to vouch for either."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "Capacity Safety — No Unbounded Self-Action", "Ownership-Gated Side Effects"]
eli16-overview: a2a-cross-machine-route.eli16.md
---

# Spec — A2A cross-machine route

The relay stays the normal route. This spec adds one backup: when my own relay connection is down, a
message to a listed peer agent on another machine is posted straight to that peer's public address,
encrypted and signed. It adds no timer, no re-send and no background work.

**Terms.** A *peer* is a different agent with its own key (Luna, Dawn), not another machine of mine.
A *fingerprint* is an agent's 32-hex-character address. An *address card* is a signed record of an
agent's public HTTPS address. A *direct peer* is a fingerprint in `threadline.directRoute.peers`.

## Problem

Evolution action ACT-052. When the relay cannot carry a message to an agent on a different machine,
there is no other route. In one incident this agent's relay connection was displaced for 6 h 45 min
and it could neither send nor receive (`src/threadline/ThreadlineEndpoints.ts:262-266`). The
operator's direction: "Threadline should be the go-to, but we need backup methods as well."

## What exists (verified at `main` 890f02396)

| Fact | Code |
|---|---|
| relay-send answers 503 when my relay client is absent or not connected. Nothing else is tried. | `src/server/routes.ts:36677-36680` |
| One agent holds **no address** for a different agent. Relay discovery returns id, name and status only. `agentCardUrl` is declared and never set. Local discovery probes `localhost` only. Verified pairing stores a peer's public key and no address. | `src/threadline/relay/types.ts:132-143`, `:24`; `src/threadline/AgentDiscovery.ts:25-54`, `:226`, `:305`; `src/threadline/AgentTrustManager.ts:63-93` |
| The channel registry says so: its peer-HTTP row is hard-coded "no peer HTTP endpoint configured". | `src/server/routes.ts:35755-35759` |
| The mesh (Tailscale, LAN, Cloudflare; `/mesh/rpc`) reaches only **my own** registered machines. So does the cross-machine message relay. | `src/core/MeshRpc.ts:316-319`; `src/server/routes.ts:21657`; `src/messaging/MessageRouter.ts:588-622` |
| A signed HTTP receive route exists, `/threadline/messages/receive`. It needs a relay token from a handshake. No production code starts that handshake or posts to that route. | `src/threadline/ThreadlineEndpoints.ts:435-545`, `:549`, `:798-803`; `src/threadline/HandshakeManager.ts:127` |
| `/a2a/inbox` and `/messages/relay-agent` are same-machine routes guarded by a local agent token. | `src/server/routes.ts:24876`, `:34606-34628` |
| A fingerprint is the first 16 bytes of the agent's Ed25519 public key, so a public key proves its own fingerprint. | `src/threadline/client/MessageEncryptor.ts:80-82` |
| A sign-and-encrypt envelope exists. It binds `from`, `to`, thread, id and time, and needs both sides' Ed25519 and X25519 public keys. | `src/threadline/client/MessageEncryptor.ts:141-204`, `:214-225` |
| In production no code gives the relay client a peer's keys, so relay messages travel as plaintext that the relay vouches for. | `src/threadline/client/ThreadlineClient.ts:400-408`, `:364-372`, `:693-709`, `:727` |
| The receiver runs every relay-vouched sender at trust level `verified`, through one handler, with the ledger commit first. | `src/threadline/ThreadlineBootstrap.ts:301-356`; `src/commands/server.ts:18224-18241`; `src/threadline/inboundIdLedgerWiring.ts:247-248` |
| The tracker keeps one row per message id. | `src/threadline/A2ADeliveryTracker.ts:262-277`, `:530` |
| The tunnel URL is known in-process. `/threadline/*` paths skip the Bearer check. A standby machine has no relay client. | `src/tunnel/TunnelManager.ts:272`; `src/server/middleware.ts:217-218`; `src/threadline/ThreadlineBootstrap.ts:177-180` |

**Plain answer.** Today no agent holds an authenticated direct address for a different agent.

## Threat model

The direct endpoint is on the public internet. Defended: a stranger posting to it; a forged or
replayed message; a forged or rolled-back card; a stale address now held by someone else (it learns
nothing and cannot fake a receipt); a card that points at a private host; a flood. Not defended: a
peer whose key is stolen. Accepted: the tunnel provider sees ciphertext sizes and timing, and a
hostname that later resolves to a private address gets ciphertext on a fixed path, with no secret.

## Design

### 1. The address card

A card is `{ v: 1, fingerprint, publicKey, x25519PublicKey, url, issuedAt }` plus an Ed25519
`signature` over the text `instar-a2a-address-card-v1`, a newline, and the canonical JSON of those
fields.

- **Issuing.** A machine issues a card only when the gate is on, its tunnel is running, and it is
  not a relay standby. `url` is the tunnel origin. The card is re-signed inline at send time when
  the URL changes or it is over 24 hours old.
- **Sending.** The card rides inside the body of an ordinary `relay-send` message, only to a direct
  peer that has not yet been sent the current card. No message is created to carry it. Automatic
  acknowledgements never carry it.
- **Accepting.** A card in an inbound relay message is stored only when all of these hold: the
  sender is a direct peer; the signature verifies with the card's own `publicKey`; the first 16
  bytes of that key equal `fingerprint`; `fingerprint` equals the relay-attested sender; `url` is
  `https` with a public hostname (no IP literal, no private, loopback or `.local` host); `issuedAt`
  is at most 5 minutes in the future and newer than the stored card's. Anything else is dropped and
  counted. A stored card is used only while it is less than 7 days old.
- **Storage.** `{stateDir}/threadline/address-cards.json` holds one card per direct peer and the
  `issuedAt` of the card last sent to each: public data only, bounded by the peers list.

### 2. The trigger: only "my relay connection is down"

The direct attempt replaces the 503 at `routes.ts:36677`, after every earlier gate has run
unchanged. It is made only when all of these hold; otherwise the answer is today's 503:

- my relay client is absent or not connected, and this machine is not a relay standby;
- the target resolves to a fingerprint without the relay (exact 32-hex, or a nickname-store match);
- that fingerprint is a direct peer with a usable card (local, or read once from my other machines);
- the send is not a credential share (`isCredentialShareSend`).

**Why this trigger is safe.** The relay never saw this message id. No relay copy can arrive later,
the tracker has one row with one route, and no duplicate is possible.

**Why the other triggers are left out.**
- *Relay answered `queued`.* The relay still holds the message and delivers it later. That copy is
  the unmarked original, in the ledger's `unverified:` namespace, which never reads the verified row
  a direct copy wrote. The repeat would be unlabelled.
- *Relay answered `rejected` (`queue-full`).* Non-delivery is proven, but the row is already
  `failed` under this id. A second route under one id needs per-attempt verdicts (ACT-057).
- *Relay answered `rejected` for another reason.* Rate limits, bans and sender faults are refusals.
- *`expired`.* It arrives hours later. Acting on it needs stored text and a background send.

### 3. Sending directly

The sender builds a `MessageEncryptor` from its own identity file and encrypts to the card's keys,
with the request's `msgId` and thread. It POSTs `{ v: 1, envelope, card }` (its own current card) to
`<url>/threadline/direct/receive`: one attempt, a 10-second timeout, no redirects.

The answer must carry a **receipt**: `{ messageId, nonce, outcome, publicKey, signature }`, signed
over `instar-a2a-direct-receipt-v1`, the message id, the envelope nonce, the sender fingerprint and
the outcome. The sender accepts it only if `publicKey` equals the stored card's key and the
signature verifies. This proves the intended fingerprint answered, not just a server at that URL.

| Result | Tracker row (written when the POST returns) | Route answer |
|---|---|---|
| Valid receipt, `outcome: accepted` | `recordSent`, transport `direct`; a reply acks it, as today | 200, `deliveryPath: 'direct'`, `delivered: false` |
| Valid receipt, `outcome: refused:<code>` | `recordSent` then `markFailed` | 503, `directStatus: 'refused'`, fixed code only |
| Connection refused or host not found | none | today's 503 |
| Anything else (timeout, no receipt, bad receipt) | `recordSent`; the existing silence sweep relabels it `unconfirmed` | 502, `directStatus: 'unconfirmed'` |

### 4. Receiving directly

`POST /threadline/direct/receive` runs these checks in order. Every answer is a signed receipt when
the body parses.

1. The gate is on, this machine is not a relay standby, and its relay state is not `displaced` →
   else `refused:not-serving`.
2. `envelope.to` equals my routing fingerprint → else `refused:wrong-recipient`.
3. `envelope.from` is a direct peer → else `refused:unknown-sender`.
4. `envelope.timestamp` is within 5 minutes of now → else `refused:stale`.
5. The request's card verifies as in §1 and names `envelope.from`, and `MessageEncryptor.decrypt`
   succeeds with its keys (this checks the envelope signature) → else `refused:bad-signature`.
6. The plaintext is at most 64 KiB, and the sender is under 30 messages a minute (120 a minute
   across all senders) → else `refused:too-large` or `refused:rate-limited`.

A message that passes goes to the same functions the relay path uses (`runRelayInboundWithLedger`,
then `handleGatePassedRelayMessage`), at trust level `verified`, the level the relay path gives. The
ledger key is the bare fingerprint, because the signature was checked here. With no ledger, an
in-memory set of ids seen in the last 10 minutes drops a replay. The card in the request is stored
by §1's rules, which keeps the address fresh. The receipt says `accepted` after the ledger commit
and before dispatch. Each send, receive and stored card writes one log line, `[a2a-direct]
id=<messageId> peer=<fingerprint> kind=sent|received|card outcome=<outcome>`.

## What it does not do

- It does not act when the relay may still hold the message, or after a relay refusal.
- It does not carry credentials, raise trust, replace verified pairing, or add peers by itself.
- It does not reach a peer with no tunnel, or a peer that has not listed me.
- It does not re-send, deduplicate, or guess delivery.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| When a direct attempt is made | invariant | Only the four conditions of §2; code decides. |
| Card acceptance and freshness | invariant | Signature, self-proving fingerprint, relay-attested sender, public `https`, newer `issuedAt`, 7-day age. |
| Direct receive admission | invariant | The six ordered checks of §4; trust equals the relay path's. |
| Receipt → tracker state and route answer | invariant | The table in §3; a missing receipt is never read as delivered. |
| Who is a direct peer | judgment-candidate | Floor: empty by default; a mutual-verified pairing counts. Arbiter: the agent adds a fingerprint only when its operator names that agent as a collaborator; the change is logged. |

## Multi-machine posture

- **Proxied-on-read (a unified posture).** Each of my machines stores the cards it receives. A
  machine with no usable card asks my other online machines once (`GET
  /a2a/address-cards?fp=<fp>&scope=pool`, at most 8 machines, 500 ms). A returned card is verified
  by its own signature, so a wrong answer costs nothing.
- **Only the serving machine speaks and listens.** A standby never issues a card, never sends
  directly and refuses direct receives. After serving moves, the new machine issues a newer card on
  its next relay message to each peer. Until then a direct message reaches the old machine and is
  refused `not-serving`. The peers list is ordinary config on each machine.

## Evidence each check relies on (symbol → state)

| Symbol | Claimed state | Corroboration | Unmeasurable case |
|---|---|---|---|
| `relayClient.connectionState !== 'connected'` | The relay never saw this id | Read in the same request, before any relay send | None; a connected client takes the relay path |
| Card signature + key prefix | The card was written by that fingerprint's key holder | Relay-attested sender equals the fingerprint | Fails → dropped, counted |
| Card `issuedAt` | The address is current | Newest wins; 7-day limit; the receipt at send time | Stale URL → no valid receipt → unconfirmed or 503 |
| Signed receipt | The intended agent took or refused this exact message | Key equals the stored card's key; id and nonce echoed | Absent or invalid → unconfirmed |
| Envelope signature + decrypt | The listed peer wrote this message for me | `to` equals my fingerprint; time window | Fails → refused |

## Frontloaded Decisions

1. **The only trigger is "my relay connection is not connected".**
2. **Direct peers are an explicit list, empty by default; my address is shared only with them.**
3. **Both ends prove identity with their own keys: a signed envelope in, a signed receipt back.**
4. **Credentials never use this route.**
5. **One attempt, no re-send; an unanswered attempt is reported unconfirmed.**
6. **Cards last 7 days, travel inside ordinary relay messages, and are re-issued inline.**
7. **Dev-gated under `threadline.directRoute`.**

## Open questions

*(none)*

## Configuration

`threadline.directRoute`: `{ enabled?: boolean, peers?: string[] }`, read live. `enabled` is omitted
from defaults, so `resolveDevAgentGate` decides (live on a development agent, dark on the fleet),
with a `DEV_GATED_FEATURES` entry. `peers` defaults to empty: inert until a peer is listed.

## Migration parity

- `ConfigDefaults`: none (`enabled` omitted on purpose).
- New file `threadline/address-cards.json`, created on first use.
- New counters on the authed `/health`. `GET /channels` replaces its hard-coded peer-HTTP row with
  a `peer-direct` row that reports how many direct peers have a usable card.
- CLAUDE.md template section, added by `migrateClaudeMd()` (sniff key `A2A direct route`).

## Rollback

`threadline.directRoute.enabled: false`, read live, restores today's 503 and makes the receive route
refuse. The card file may be left or deleted.

## Agent awareness

Template + migrator section (`### A2A direct route`): "When my own relay connection is down, a
message to an agent I have listed as a direct peer goes straight to that agent's server, encrypted
and signed, if I hold its address card. `deliveryPath: 'direct'` means the peer's server signed for
it; only a reply proves it was read. `directStatus: 'unconfirmed'` means unknown, not lost; I do not
resend in a loop. A credential never goes this way. Both agents must list each other and run a
tunnel. **When to use** (PROACTIVE): my operator names an agent as a collaborator → add its
fingerprint to `threadline.directRoute.peers` and ask the peer to add mine; a peer is unreachable
→ read the `peer-direct` row of `GET /channels` before saying there is no other route."

## Tests

- **Unit:** card sign and verify; each §1 rejection; both sides of each §2 condition (connected,
  standby, unresolved name, non-peer, no card, stale card, credential); receipt checks (wrong key,
  id, nonce; absent); the §3 result table; each §4 refusal in order; a replay; both rate limits.
- **Integration:** two real servers, relay stopped. A listed peer with a card receives the message
  once, through the ledger, at trust `verified`; the sender's row is `awaiting-ack` with transport
  `direct`. An unlisted sender is refused. A stale URL answered by another server yields
  `unconfirmed`, and that server cannot decrypt. A standby refuses. A credential send gets the 503.
  With the relay connected, no direct attempt is made.
- **E2E:** production bootstrap with the gate on mounts `/threadline/direct/receive` (a signed
  refusal, not 404) and shows the `peer-direct` channel row; with the gate off, today's behaviour.

## Maturation plan

- **test-agent-live:** two throwaway agents on two machines, each listing the other, relay stopped
  on the sender: one direct delivery with a valid receipt and one refused unlisted sender, observed.
- **dev-agent-live:** gate on for 48 hours on the development agent, one remote peer listed both ways.
- **fleet:** flip `threadline.directRoute.enabled` fleet-wide after the graduation criterion holds.
- **graduation criterion:** from the `[a2a-direct]` lines, at least one `kind=sent outcome=accepted`
  whose receipt verified, matched by a `kind=received` line on the peer, and at least one stored
  card. A zero count is not a pass.
- **dark-window:** at most 7 days from merge to the fleet decision. If a count is still zero then,
  the reason and a new date go on ACT-052; it is never left dark silently.

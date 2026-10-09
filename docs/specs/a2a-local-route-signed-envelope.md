---
title: A2A local-route signed envelope — the same-machine route proves its sender
slug: a2a-local-route-signed-envelope
date: 2026-10-09
author: echo
parent-spec: a2a-local-route-trust.md
depends-on: a2a-inbound-id-ledger.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "The same-machine route takes the sender's name from the request body and acts on it. This change makes the route prove that name before anything downstream reads it: the envelope must carry an Ed25519 signature that verifies against the public key this agent has on record for that name. An envelope that cannot prove its sender is refused before it is recorded anywhere."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "Structure > Willpower", "The Agent Is Always Reachable"]
eli16-overview: a2a-local-route-signed-envelope.eli16.md
approved: true
approved-by: "operator directive for CMT-706 — Justin, Telegram topic 9210, 2026-10-09 (“please proceed as you recommend” / “go”)"
---

# Spec — A2A local-route signed envelope

Tracking action: ACT-067. Commitment: CMT-706.

**Terms.** The *local route* is `POST /messages/relay-agent`, the route one
agent uses to hand a message straight to another agent on the same machine.
The *envelope* is the JSON body of that request: `{ schemaVersion, message,
transport, delivery }`. The *registry* is `{stateDir}/threadline/known-agents.json`,
the receiver's record of the same-machine agents it has discovered: for each,
a name, a port, a 32-hex-character fingerprint and the 64-hex-character
Ed25519 public key that fingerprint is derived from. The *identity* is the
agent's own Ed25519 key pair, read through `IdentityManager`.

## Problem

The local route authenticates the caller with the receiver's own agent token.
That proves the caller can read a file on this machine. It does not prove who
the caller is. The sender's name (`message.from.agent`) and fingerprint
(`message.from.fingerprint`) are text in the request body, and every
downstream consumer — the local-route trust check, the inbound-id ledger's
`registry:` key, the thread-owner attribution, the trust level stated to the
receiving session — acts on that text.

The relay path does not have this gap. A relay envelope is signed with the
sender's Ed25519 identity key over its canonical fields, and the receiving
client verifies the signature against the sender's public key before the
message is decrypted (`MessageEncryptor.decrypt`). The local-route trust spec
records the gap in its "What it does not do": *"It does not authenticate the
sender. … Proving the sender on this route needs a signed envelope, which is
recorded on ACT-067."*

Dawn's same-machine backup route (the-portal,
`docs/specs/threadline-same-machine-route.md`) is switched off until the local
route proves its sender. This spec is that proof.

## What exists (verified on `main` = 3068301f5)

- **The route** (`src/server/routes.ts`, `router.post('/messages/relay-agent')`)
  checks, in order: the bearer token (`verifyAgentToken`), the envelope shape
  (`message.id` present), the relay-chain loop, the local-route trust
  verdict, the content window, then the inbound-id ledger commit. Nothing
  verifies a signature; the envelope carries none.
- **Two senders build that envelope, both in-process.** The name path of
  `POST /threadline/relay-send` (`routes.ts`, "Try local delivery first")
  builds it with `from: { agent: projectName, fingerprint: <own fingerprint> }`
  and reads the agent's identity through `IdentityManager.get()` for the
  fingerprint. `MessageRouter.relayToAgent` (the cross-agent path of
  `POST /messages/send`) posts the envelope `MessageRouter.send` built, whose
  `from` is the caller's `from` field. Neither signs.
- **The registry holds the key.** `AgentDiscovery.discoverLocal()` pings each
  running registry agent's `/threadline/health` and records `identityPub`
  (hex Ed25519 public key, 64 characters) as `publicKey` and `fingerprint`
  (`computeFingerprint(publicKey)`: the first 16 bytes of the key, hex) into
  `known-agents.json`. `discoverLocal()` runs only from the `threadline_discover`
  MCP tool; the presence heartbeat refreshes status for entries already
  recorded and never adds or removes an entry. `resolvePeerFingerprintByName`
  (`src/threadline/peerFingerprint.ts`) already resolves a name to exactly
  one fingerprint through this file, returning null on a missing file, an
  absent name, or a name collision with two different fingerprints.
- **The primitives exist.** `ThreadlineCrypto.sign` / `verify` (raw 32-byte
  keys, 64-byte signatures) are the functions the relay envelope uses.
- **A 401 from the local route is already in the backup-routes
  non-admission set** (`backupRoutes.ts`, `NON_ADMISSION_STATUSES`): a
  relay-send fall-through after a 401 is unmarked, because the receiver
  recorded nothing.

## Design

### 1. The signed envelope

The sender adds one field to the envelope: `signature`, a base64 string of
the 64-byte Ed25519 signature over the canonical bytes of

```
"instar-a2a-local-envelope-v1\n" + canonicalJson({ message, transport: { nonce, timestamp } })
```

`canonicalJson` serialises with object keys sorted at every level, no
whitespace, `undefined` members omitted, arrays in order. The prefix is
domain separation: a signature made for this route can never verify as a
relay envelope signature or as an agent-signature-provenance (ASP) message.
The signed set covers the whole `message` (id, from, to, type, priority,
subject, body, threadId, createdAt, resend) and the transport nonce and
timestamp, so a signed envelope is bound to one attempt. `schemaVersion`
stays `1`: the field is additive and a receiver that predates this spec
ignores it.

Module: `src/threadline/localEnvelopeSignature.ts` —
`canonicalJson`, `signLocalEnvelope(envelope, privateKey)`,
`verifyLocalEnvelope(envelope, publicKey)`, `verifyLocalRouteEnvelope(stateDir,
envelope)` (the route's whole verdict), the counters and the log line.

### 2. Key source: the registry, by name

The receiver resolves `message.from.agent` through `known-agents.json` to
exactly one entry carrying a 64-hex public key, with the collision rule
`resolvePeerFingerprintByName` already applies (two entries with the same
name and different keys resolve to nothing). The entry's public key is the
verification key; its fingerprint is the proven sender fingerprint. There
is no other key source: the body's `from.fingerprint` is never used to pick
a key, and the route never fetches a key from the network.

When the body carries `from.fingerprint`, it must equal the resolved
fingerprint (compared lower-cased). A body that names one agent and claims
another's fingerprint is refused.

### 3. Placement: after the token check, before anything reads the sender

The verification runs after the bearer-token check and the envelope-shape
check, and before the relay-chain loop check, the trust check, the content
window and the ledger commit. A refused envelope therefore leaves no ledger
row, holds no content window, reaches no inbox and is never attributed to a
thread. Auth stays first: a wrong token answers `401 Invalid or missing agent
token` whether or not the envelope is signed.

The proven fingerprint replaces the body-derived identity downstream: the
trust check's `registryFingerprint` and the ledger's `registry:` key are the
proven value. The body's asserted fingerprint is no longer consulted by the
trust check on this route (it has been checked for equality already).

### 4. Failure codes

Every failure is HTTP 401 with the body

```
{ error: "bad-signature", refused: true, retryable: false, reason: <reason> }
```

| `reason` | When |
|---|---|
| `unsigned` | no `signature` field |
| `malformed` | `signature` is not base64 of 64 bytes, or `transport.nonce` / `transport.timestamp` is not a string, or `message.from.agent` is not a non-empty string |
| `unknown-sender` | the registry has no entry for the sender name, or the registry file is missing, unreadable or over the size bound |
| `ambiguous-sender` | two registry entries with that name resolve to different fingerprints |
| `no-public-key` | the matching entry has no 64-hex public key (an entry written before keys were recorded) |
| `fingerprint-mismatch` | the body's `from.fingerprint` differs from the entry's fingerprint |
| `signature-invalid` | Ed25519 verification against the entry's key fails |

`retryable: false` is honest for all seven: the same envelope resent
unchanged gets the same answer. The remedy for `unknown-sender` and
`no-public-key` is on the RECEIVER (run `threadline_discover` so the sender's
key is recorded); the remedy for the rest is on the sender. The body carries
no key material and no registry contents.

### 5. The senders sign

- The relay-send name path signs with the identity it already reads for the
  sender fingerprint (`IdentityManager.get()`). When no identity resolves
  (none on disk, or locked-encrypted), the envelope is sent unsigned and the
  receiver refuses it with `unsigned`; the sender's existing fall-through
  then takes the relay, which also needs an identity, so such an agent gains
  and loses nothing.
- `MessageRouter` takes an optional `envelopeSigner` in its config
  (`(envelope) => string | null`); `server.ts` wires one that signs with the
  agent's identity. `relayToAgent` signs immediately before the POST. With no
  signer (a test router, or no identity) the POST is unsigned and the
  receiver's refusal is a failed relay, which falls to the existing drop
  directory exactly as an unreachable target does.

A sender always signs, whatever the receiver's version: an older receiver
ignores the field, so senders and receivers update in any order.

### 6. Counters and logging

In memory, per machine, on the authed `/health` under
`threadline.localRouteSignature`: `signerAvailable` (this agent can sign its
own outbound envelopes), `verified`, `refused`, and `refusedByReason` keyed
on the seven reasons above. One server-log line per refusal:
`[relay-agent-signature] refuse from=<name> reason=<reason>`, the name
reduced to printable ASCII and cut to 48 characters. No message text, no key
material.

## What it does not do

- It does not change what the ledger keys on. A local row still lives under
  `registry:<fp>`; promoting a proven local sender to the ledger's verified
  namespace (so a relay copy and a local copy of one message dedupe against
  each other) is now possible and is a follow-up, not part of this change.
- It does not bound the timestamp. A signed envelope can be replayed with its
  original nonce and timestamp; the inbound-id ledger (same id) and the
  content window (same sender, thread, text) stop that within their windows,
  as today. A freshness bound is a later addition if a measured replay shows
  up.
- It does not check `message.to.agent` against the receiver's own name. `to`
  is inside the signed bytes, so the check is cheap to add later; it is left
  out to keep this change to the one thing ACT-067 names.
- It does not add the key to the registry on first contact. The registry is
  written by discovery only, so a receiver that has never discovered a sender
  refuses it with `unknown-sender` until it does. That is a deliberate limit:
  a route that recorded keys on a caller's say-so would let the caller choose
  the key it is checked against.
- It does not cover `/a2a/inbox`, the other same-machine transport, which
  has its own accept boundary (`a2a-inbox-accept-boundary.md`).
- It does not defend against a process running as the same user. Such a
  process can read every agent's identity file on the machine. The floor
  closes misattribution by construction (a bug, a stale registry, a wrong
  `from` field) and gives downstream checks a proven identity; it is not an
  OS boundary.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Admit or refuse a local-route envelope by signature | invariant | Admitted only when the Ed25519 signature verifies against the registry key for the body's sender name and any body fingerprint equals the registry fingerprint. No mode, no override. |
| Which key verifies | invariant | The `known-agents.json` entry for the sender name, exactly one, with a 64-hex public key. Never a key from the body, never a key fetched on demand. |
| What downstream reads as the sender | invariant | The proven fingerprint. The trust check and the ledger key take it in place of the body-derived value. |

## Multi-machine posture

Machine-local, for the same reason the local-route trust check is: the route
is loopback-only, the registry it reads is the one discovery wrote on this
machine, and the identity that signs is this machine's copy of the agent's
identity. A message for this agent arriving on another of its machines
arrives on that machine's own local route, verified against that machine's
registry. Counters are per machine, not merged. No notice, no durable state,
no URL is produced, so nothing can double-fire or strand on a transfer.

## Rollout

Live, no flag. A security floor that ships dark guards nothing, and the
route's consumers (Dawn's route among them) need the proof to be
unconditional to rely on it. What this costs, stated:

- **A mixed-version machine during an update.** An updated receiver refuses
  an older sender's unsigned envelope. A relay-send sender falls through to
  the relay (judged there under the relay's rules); a `MessageRouter` sender
  falls to the drop directory and is picked up on the target's next start.
  The window closes when the sender updates; the auto-updater rolls a
  machine's agents within minutes of each other.
- **A receiver that has never discovered the sender** refuses it with
  `unknown-sender` until `threadline_discover` runs there. On the development
  machine on 2026-10-09 the development agent's registry lists three of the
  four same-machine agents. The refusal names the sender in the log and on
  the counters, so the missing discovery is visible, never silent.

## Rollback

None in configuration: a floor with an off switch is not a floor. Rolling
back is reverting the release. Nothing is stored, so there is no state to
repair.

## Migration parity

- No config field is added. Nothing to migrate.
- CLAUDE.md: one section "A2A local-route signed envelope" in the template
  and in `migrateClaudeMd` (sniff key `A2A local-route signed envelope`),
  listed among the framework-shadowed sections (a Codex or Gemini agent must
  know the 401 and the discovery remedy).
- Counters on the authed `/health` under `threadline.localRouteSignature`.

## Agent awareness

| Section | Content |
|---|---|
| A2A local-route signed envelope | The same-machine route now refuses an envelope that does not carry a valid signature from the key on record for its sender name (`401 bad-signature`, `reason` names which check failed). When a same-machine peer reports that refusal with `unknown-sender`, run `threadline_discover` here so its key is recorded; `signature-invalid` or `fingerprint-mismatch` means the peer is signing with a key other than the one recorded for its name — re-discover and, if it persists, treat the peer's identity as changed. Counters: authed `/health` → `threadline.localRouteSignature`. |

## Tests

- **Unit** (`tests/unit/a2a-local-route-signed-envelope.test.ts`):
  canonicalisation (key order at every level, `undefined` dropped, arrays
  kept); sign then verify with the real key pair; every reason against a real
  registry file (unsigned, malformed signature, non-string nonce, unknown
  sender, ambiguous name, entry without a key, fingerprint mismatch, wrong
  key, tampered body, tampered nonce); the proven fingerprint on success; the
  signer helper with and without an identity; the log line reduces the name;
  migration parity (template section present, migrator adds it once).
- **Integration** (`tests/integration/threadline/a2a-local-route-signed-envelope.test.ts`):
  the real route on a real `AgentServer` with a real ledger and registry:
  auth first; each refusal is `401 bad-signature` with its reason and leaves
  no inbox entry, no ledger row and no content window; a signed envelope is
  delivered and the trust check and ledger see the proven fingerprint; a
  real `MessageRouter` with the production signer delivers to a second real
  server; counters on `/health`.
- **E2E** (`tests/e2e/threadline/a2a-local-route-signed-envelope-alive.test.ts`):
  two real servers booted the production way (`bootstrapThreadline`, a real
  relay): `/health` reports the floor alive with a signer; the sender's real
  relay-send name path delivers locally and `verified` counts one; a
  hand-rolled unsigned POST is refused and never reaches the router; a
  receiver that has not recorded the sender's key refuses `unknown-sender`
  and the sender's fall-through takes the relay.
- **Existing tests that post to the route** are updated to sign through one
  shared helper (`tests/helpers/localEnvelope.ts`) and to record the sender's
  key in the receiver's registry — the same change every real sender makes.

## Maturation plan

Live from merge. Evidence that it holds: on the development agent, the
`/health` counters after 24 hours show `verified` rising with same-machine
traffic and every `refused` explained by its reason and log line. A
`signature-invalid` or `fingerprint-mismatch` from a known same-machine
agent is a bug to report, not a tuning question.

---
title: A2A local-route signed envelope — the same-machine route proves its sender
slug: a2a-local-route-signed-envelope
date: 2026-10-09
author: echo
parent-spec: a2a-local-route-trust.md
depends-on: a2a-inbound-id-ledger.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "The same-machine route takes the sender's name from the request body and acts on it. This change makes the route prove that name before anything downstream reads it: the envelope must carry an Ed25519 signature that verifies against the public key this agent has on record for that name, and the identity every downstream consumer reads is derived from that verified key. An envelope that cannot prove its sender is refused before it is recorded anywhere, and a refusal is terminal on every sender path, including the offline drop directory."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "Structure > Willpower", "No Manual Work (user or agent)", "The Agent Is Always Reachable", "Verify the State, Not Its Symbol"]
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
Ed25519 public key that fingerprint is derived from. The *AgentRegistry* is
the machine-wide `~/.instar/registry.json` every agent server registers its
name, path and port in. The *identity* is the agent's own Ed25519 key pair,
read through `IdentityManager`. The *drop directory* is
`~/.instar/messages/drop/<target>/`, where `MessageRouter` parks an envelope
it could not hand over, for the target to ingest at its next start.

## Problem

The local route authenticates the caller with the receiver's own agent token.
That proves the caller can read a file on this machine. It does not prove who
the caller is. The sender's name (`message.from.agent`) and fingerprint
(`message.from.fingerprint`) are text in the request body, and every
downstream consumer — the local-route trust check, the inbound-id ledger's
`registry:` key, the thread-owner attribution, the warrants-reply gate, the
trust level stated to the receiving session — acts on that text.

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
  verifies a signature; the envelope carries none. The route reads the
  registry twice per request: once for the trust check and ledger key
  (`resolvePeerFingerprintByName`), once more after the response for the
  thread-attribution fingerprint.
- **Two senders build that envelope, both in-process.** The name path of
  `POST /threadline/relay-send` (`routes.ts`, "Try local delivery first")
  builds it with `from: { agent: projectName, fingerprint: <own fingerprint> }`
  and reads the agent's identity through `IdentityManager.get()` for the
  fingerprint. `MessageRouter.relayToAgent` (the cross-agent path of
  `POST /messages/send`) posts the envelope `MessageRouter.send` built, whose
  `from` is copied verbatim from the caller's request body. Neither signs.
- **`MessageRouter` cannot tell a refusal from an outage.** `relayToAgent`
  returns `response.ok`; on `false` for any reason the envelope is written to
  the drop directory with an HMAC keyed on the SENDER's token, and
  `pickupDroppedMessages` (run once at the target's boot) checks that HMAC
  and saves the envelope straight into the target's message store — no trust
  check, no ledger, no signature. A 401 and a dead server are the same event
  to this sender today.
- **The registry holds the key, recorded on trust-on-first-use.**
  `AgentDiscovery.discoverLocal()` reads the AgentRegistry, pings each
  `running` entry's `/threadline/health` on loopback, and records the
  answer's `identityPub` (hex Ed25519 public key) as `publicKey` and its
  `fingerprint` field VERBATIM (it does not derive it from the key). The
  write REPLACES the whole file with the agents reachable at that instant: a
  peer that is down during a discover is dropped (changed by this spec, §3). `discoverLocal()` runs
  only from the `threadline_discover` MCP tool; the presence heartbeat
  refreshes status for entries already recorded and never adds, removes or
  re-keys an entry. So the name→key binding is "whatever process answered on
  the port the AgentRegistry named for that name, at discovery time" — the
  same unauthenticated loopback source the signature check will rest on.
- **A name resolver exists but returns the wrong thing for this.**
  `resolvePeerFingerprintByName` (`src/threadline/peerFingerprint.ts`)
  resolves a name to one fingerprint (`fingerprint || publicKey[:32]`,
  lower-cased; null on a missing file, an absent name, or two entries with
  that name and different derived fingerprints). It returns no key, and it
  prefers the entry's stored `fingerprint` field over the key.
- **The primitives exist.** `ThreadlineCrypto.sign` / `verify` (raw 32-byte
  keys, 64-byte signatures) are the functions the relay envelope uses.
  `AgentTokenManager` carries a deep-key-sorting `canonicalJSON` (JCS-style)
  used for the drop HMAC.
- **A 401 from the local route is already in the backup-routes
  non-admission set** (`backupRoutes.ts`, `NON_ADMISSION_STATUSES`): a
  relay-send fall-through after a 401 is unmarked, because the receiver
  recorded nothing.
- **The inbound-id ledger is dev-gated** (dark on the fleet) and its local
  namespaces (`registry:`, `asserted:`, `local:`) never suppress a
  completed repeat — a same-id local copy is re-admitted with a notice. The
  content window is in-memory, 60 seconds.
- **The route is reachable beyond loopback on a mesh agent.** `AgentServer`
  binds the Tailscale/LAN interfaces when the mesh is active; the route stays
  behind the per-agent token either way.

## Design

### 1. The signed envelope

The sender adds one field to the envelope: `signature`, a base64 string of
the 64-byte Ed25519 signature over

```
UTF-8( "instar-a2a-local-envelope-v1\n" + canonicalJSON({ message, transport: { nonce, timestamp, relayChain } }) )
```

`canonicalJSON` is the ONE deep-key-sorting canonicaliser already in
`AgentTokenManager` (exported, not duplicated): object keys sorted by UTF-16
code unit at every level, no whitespace, `undefined` members omitted from
objects and rendered `null` inside arrays, strings and numbers exactly as
`JSON.stringify` renders them (non-finite numbers become `null`). The signed
value is the JSON-round-tripped envelope: the sender signs the object it is
about to serialise, the receiver canonicalises the object `express.json`
parsed (so a duplicate wire key resolves last-wins on both ends and a
`__proto__` key is an own property, never a prototype write). Two bounds,
both answered `malformed`: nesting deeper than 64 levels, and a signed set
over 1 MB serialised.

The prefix is domain separation. The three other preimages signed with the
same identity key are the relay envelope (begins `{`, `MessageEncryptor.
canonicalizeEnvelope`), the agent-signature-provenance message (begins
`asp1\n`) and pair-verify (`threadline-pair-verify-v1`); none can begin with
`instar-a2a-local-envelope-v1\n`, so a signature made for this route verifies
nowhere else and vice versa. The signed set covers the whole `message` (id,
from, to, type, priority, subject, body, threadId, createdAt, resend), the
transport nonce and timestamp, and the relay chain (both senders set it
before the POST; it decides a 409). `delivery` and the top-level
`threadSync` stay unsigned: `delivery` is the receiver's own bookkeeping
after admission, and `threadSync` is advisory (a symmetry hint the receiver
cross-checks, never acts on). `schemaVersion` stays `1`: the field is
additive and a receiver that predates this spec ignores it.

Module: `src/threadline/localEnvelopeSignature.ts` — `localEnvelopeSignedBytes`,
`signLocalEnvelope(envelope, privateKey)`, `verifyLocalEnvelope(envelope,
publicKey)`, `lookupRegistryKeyByName`, `verifyLocalRouteEnvelope` (the
route's whole verdict, including self-discovery), the replay cache, the
counters, the log line and the degradation reports.

### 2. Key source: the registry, by name; identity derived from the key

The receiver resolves `message.from.agent` (compared lower-cased) through the
registry to the entries with that name. Each entry must carry a 64-hex
`publicKey`; entries without one are set aside. Exactly one distinct public
key must remain: zero → `unknown-sender` (after self-discovery, §3); more
than one distinct key under the name → `ambiguous-sender`; one key that ALSO
appears under a different name (a cloned agent home) → `ambiguous-sender`,
because that key could sign as either name. An entry whose stored
`fingerprint` field disagrees with `computeFingerprint(publicKey)` is
`registry-entry-invalid` (stale or hand-edited; a verifying key must never
be attributed to a fingerprint it does not derive to).

The entry's public key is the verification key. The **proven fingerprint is
always `computeFingerprint(publicKey)`** — the stored `fingerprint` field is
checked for consistency and never consumed. There is no other key source:
the body's `from.fingerprint` is never used to pick a key.

When the body carries `from.fingerprint`, it must equal the proven
fingerprint in full (32 hex, compared lower-cased; a prefix is a mismatch).
A body that names one agent and claims another's fingerprint is refused.

**What this proves, stated honestly.** The key on record was taken on
trust-on-first-use from an unauthenticated loopback endpoint at the port the
AgentRegistry named for that name. The signature therefore proves
continuity with the process that answered on that port when the key was
recorded — not identity in any stronger sense. That is the same anchor the
relay's discovery rests on, and it is the right one within the threat model
(§What it does not do): the floor closes misattribution by construction (a
wrong `from`, a stale body fingerprint, a process holding the token but no
key) and gives every downstream check a value derived from a verified key.

### 3. Self-discovery: the receiver fetches the key it is missing

A receiver that has never discovered a sender does not wait for a human to
run `threadline_discover`. On `unknown-sender` ONLY — no entry under the name
carries a usable key — the route performs ONE bounded discovery step itself,
in the request path, then re-verifies once. **The route only ever ADDS a key
it does not have; it never replaces one.** A `signature-invalid` or
`fingerprint-mismatch` against a key on record is refused as such and is
never a trigger: adopting whatever process currently answers on the port
would let a new process inherit a known principal's standing (Know Your
Principal). A rotated identity reaches the registry only through an explicit
`threadline_discover` (the operator's or the agent's deliberate action):

1. Look the sender name up in the AgentRegistry (`listAgents({status:
   'running'})`). Exactly one running entry must match the name (none → the
   refusal stands; two → `ambiguous-sender`).
2. `GET http://localhost:<port>/threadline/health` with a 2.5 s timeout
   (inside both senders' POST budgets, 10 s and 5 s). The answer must say
   `protocol: 'threadline'` and carry a 32-byte `identityPub`; anything else
   fails the step. This is exactly what `discoverLocal` reads, from the same
   source, so the trust anchor does not move.
3. Add the entry (name, port, `publicKey`, `fingerprint` =
   `computeFingerprint(publicKey)`) to the registry — merged by name (a
   key-less entry under that name is completed, every other entry kept),
   written atomically. The step re-reads the file first: if an entry with a
   usable key for the name exists by then (a concurrent discover), nothing
   is written and that key is used.
4. Verify the envelope once more against the new key. The verdict of that
   second pass is final; the step never runs twice for one request.

Brakes (No Unbounded Loops / Capacity Safety): the total number of probes
CONVERGES. A probe is attempted only for a name that matches exactly one
RUNNING AgentRegistry entry (anything else costs one registry read and no
network), with a backoff that DOUBLES after each failure for that name —
60 s, 2 min, 4 min, 8 min, 16 min — and at most FIVE failed probes per name
per process; after the fifth failure the name is closed — the route answers
`unknown-sender` without probing until the process restarts or the entry
arrives through `threadline_discover`. So the ceiling is five probes per
registered running agent per process (the last ~31 minutes after the first),
not a rate that continues forever. Counted `selfDiscovered`, `selfDiscoveryFailed`, `probeClosed`
(names closed). When a name closes the receiver files ONE degradation
report naming the sender — so a peer that is registered but never answers
is visible to the operator, not just to a counter. The state is in memory
and per process; a restart resets it, which is the safe direction (one
fresh ladder of at most five probes per name).

`discoverLocal` changes in ONE way: it MERGES into the registry instead of
replacing the file. An entry for a peer that did not answer during the sweep
is KEPT (its key stays on record; its status is left as it was), and an
entry for a peer that did answer is updated — including its key, which is
the one deliberate re-key path. Without this, a discover run while a peer is
briefly down would erase its established key, and the add-only self-discovery
above could then bind that name to whatever process next answered on its port
(the gate's finding). Entries are never removed by discovery. When a discover
REPLACES the key of a name already on record, that is logged
(`[threadline-discover] key changed for <name>`), counted (`discoverKeyChanged`)
and reported once per name (`Threadline.localRouteSignature`), so a re-key is
never silent. It still records the new key: explicit discovery is this
machine's trust-on-first-use anchor (§2), and a re-key that needs a verified
authorization is the verified pairing spec's job, stated in "What it does
not do" — this spec narrows the unauthenticated re-key to the ONE deliberate
path and makes it visible; it does not remove it.

### 4. Placement: after the token check, before anything reads the sender

The verification runs after the bearer-token check and the envelope-shape
check, and before the relay-chain loop check, the trust check, the content
window and the ledger commit. A refused envelope therefore leaves no ledger
row, holds no content window, reaches no inbox and is never attributed to a
thread. Auth stays first: a wrong token answers `401 Invalid or missing agent
token` whether or not the envelope is signed. Ordering before the loop check
is for refusal conservation (a loop envelope with a bad signature is refused
for the signature), not for cost.

The proven fingerprint replaces every body-derived identity downstream, in
one read of the registry per request (the two existing reads go away):

- the trust check's `registryFingerprint`;
- the inbound-id ledger key — **promoted to the verified namespace** (the
  bare fingerprint, the key the relay path uses), because the sender is now
  proven; a local copy and a relay copy of one message now dedupe against
  each other, which the ledger spec names as the purpose of proving the
  local sender;
- the thread-attribution fingerprint read after the response;
- the warrants-reply gate's `senderFingerprint` and the ack recorder's
  `senderFingerprint` (today both receive the body NAME; they receive the
  proven fingerprint, with the name beside it where a name is displayed).

The body's asserted fingerprint is no longer consulted anywhere on this
route (it has been checked for equality and is otherwise dead).

### 5. Freshness, replay, recipient

- **Recipient.** `message.to.agent` is REQUIRED and must equal the
  receiver's `projectName` (lower-cased); absent or different →
  `wrong-recipient`. A signature proves "A wrote this for B" only if B is
  named inside the signed bytes; without the check (or with the field
  optional) any holder of C's token could replay A's envelope to C, where it
  would verify. `to` is inside the signed bytes, so the check is one
  comparison. Both real senders already set it.
- **Freshness.** `transport.timestamp` is signed. It must parse as an
  instant no more than 10 minutes in the past and no more than 2 minutes in
  the future of the receiver's clock (sender and receiver share one machine
  clock); otherwise `stale`.
- **Replay.** The receiver keeps an in-memory cache of
  `(proven fingerprint, nonce)` with a 12-minute lifetime — longer than any
  fresh envelope can live, so an entry never expires while its envelope is
  still admissible — bounded to 4,096 entries. A second envelope with the
  same pair inside the lifetime is `replay`. At the bound the receiver does
  not evict silently: it refuses new admissions `replay-cache-full`
  (retryable, receiver) until entries age out — refusing is the safe
  direction; 4,096 same-machine sends in twelve minutes is not a real load.
  Together with the freshness bound this stops a byte-identical re-POST on
  every agent, including the fleet where the inbound-id ledger is dark and
  the content window is 60 s. **The one gap, stated:** the cache is
  per-process. A receiver restart empties it, so an envelope captured in the
  last ten minutes before a restart can be admitted once in the ten minutes
  after it; the inbound-id ledger (where on) still labels that copy by id.
  Persisting the cache would buy a replay window measured in minutes at the
  cost of a durable write per message; not worth it inside the stated
  threat model. A legitimate resend from the relay-send fall-through goes
  over the relay, not this route; a `MessageRouter` send has no retry; so no
  real sender hits the replay check.

### 6. Failure codes

Every failure is HTTP 401 with the body

```
{ error: "bad-signature", refused: true, retryable: <bool>, remedy: "sender" | "receiver", reason: <reason> }
```

| `reason` | When | `retryable` | `remedy` |
|---|---|---|---|
| `unsigned` | no `signature` field | false | sender |
| `malformed` | `signature` is not base64 of 64 bytes (or over 128 characters), `transport.nonce` / `transport.timestamp` is not a string, `message.from.agent` is not a non-empty string, or a canonicalisation bound (§1) is exceeded | false | sender |
| `stale` | `transport.timestamp` is not an instant within ±10 minutes | false | sender |
| `replay` | the (fingerprint, nonce) pair was seen inside the cache lifetime | false | sender |
| `replay-cache-full` | the replay cache is at its bound and no entry has aged out | true | receiver |
| `wrong-recipient` | `message.to.agent` is absent or is not this agent | false | sender |
| `unknown-sender` | no registry entry with a usable 64-hex key for the name, and self-discovery could not add one (not registered as running, health did not answer, or the name is closed after five failed probes) | true | receiver |
| `ambiguous-sender` | two distinct keys under the name, the key under two names, or two running AgentRegistry entries with the name | false | receiver |
| `registry-entry-invalid` | the matching entry's stored `fingerprint` disagrees with `computeFingerprint(publicKey)` (stale or hand-edited); never repaired by the route — a re-discover is the remedy | true | receiver |
| `registry-unavailable` | the registry file exists but is unreadable, unparseable or over the 1 MB bound | true | receiver |
| `fingerprint-mismatch` | the body's `from.fingerprint` differs from the proven fingerprint | false | sender |
| `signature-invalid` | Ed25519 verification fails against the key on record (a sender signing with a key other than the one recorded — including a rotated identity — is refused, never re-keyed by the route) | false | sender |

`retryable` means: a later identical envelope may succeed because the
RECEIVER's state can change (its registry, its view of the peer); `false`
means the sender must change something. `remedy` names which side. The body
carries no key material and no registry contents; the five receiver-side
reasons do reveal whether the receiver knows a name, which any token holder
could learn from the AgentRegistry anyway.

### 7. The senders sign, and a refusal is terminal on every sender path

- **The relay-send name path** signs with the identity it already reads for
  the sender fingerprint (`IdentityManager.get()`, a raw 32-byte private
  key). When no identity resolves (none on disk, or locked-encrypted), the
  envelope is sent unsigned and the receiver refuses it `unsigned`; the
  sender's existing fall-through then takes the relay, which also needs an
  identity, so such an agent gains and loses nothing. A 401 is non-admission
  (unchanged), so the fall-through is unmarked.
- **`MessageRouter`** takes an optional `envelopeSigner` in its config
  (`(envelope) => string | null`); `server.ts` wires one over the same
  `IdentityManager` instance the server already holds (the instance caches
  the loaded identity, so signing is one Ed25519 operation per send, and an
  identity provisioned after boot is picked up on the next `get()`).
  `relayToAgent` signs immediately before the POST, after the relay chain is
  final. **The signer never rewrites `from`, and never lends this agent's
  signature to another name:** `from.agent` must equal the router's
  `localAgent` (lower-cased) or the envelope is sent unsigned, counted
  `signRefusedForeignFrom`. On this route `from` means the signing agent;
  `POST /messages/send` with a foreign `from` to a same-machine target is
  refused by the receiver as `unsigned` — the misattribution the floor
  exists to stop.
- **A refusal does not drop.** `relayToAgent` returns a classified outcome:
  `accepted`, `refused` (any 4xx: the receiver answered and said no — the
  body's `error`/`reason` are recorded on the envelope's delivery
  transition and in one log line, and the send FAILS, phase `failed`) or
  `unreachable` (network error, timeout, 5xx). Only `unreachable` and
  "agent not registered" write to the drop directory. A refused envelope
  never reaches the drop directory, so a refusal cannot be laundered into a
  later unsigned delivery.
- **The drop directory verifies the same signature.** An envelope that does
  reach the drop directory was signed at send time (the signature rides
  with it; the drop HMAC covers the same fields and is unchanged).
  `pickupDroppedMessages` verifies the signature with
  `verifyLocalRouteEnvelope` against the receiver's registry (same reasons,
  same self-discovery, same proven fingerprint) before saving, and rejects
  an unsigned or unverifiable drop with the reason in its rejection list —
  the same floor on the offline path. Cost, stated: drops written by a
  sender from before this release carry no signature and are rejected at the
  first boot after the update (counted and logged; the sender's send already
  reported them as parked). The drop pickup is one boot-time pass, as today;
  bounding the drop directory's growth is outside this change.

A sender always signs, whatever the receiver's version: an older receiver
ignores the field, so senders and receivers update in any order.

### 8. Capability advertisement

The unauthenticated `GET /threadline/health` (the endpoint discovery already
reads) gains `localEnvelopeSignature: "v1"`. A same-machine consumer — Dawn's
backup route in the-portal — can key its switch-on on that field instead of
inferring it from a 401 that is shared with a token failure.

### 9. Counters, logging, degradation

In memory, per machine, on the authed `/health` under
`threadline.localRouteSignature`:

- receiver: `verified`, `verifiedBySender` (name → count, bounded to 64
  names), `lastVerifiedAt`, `refused`, `refusedByReason` keyed on the twelve
  reasons, `recentRefusals` (the bounded ring, below), `selfDiscovered`,
  `selfDiscoveryFailed`, `probeClosed`, `discoverKeyChanged`, `replayCacheSize`;
- sender: `signerAvailable` (evaluated at read time: `IdentityManager.get()
  !== null`), `signed`, `signFailures`, `signRefusedForeignFrom`,
  `lastSignedAt`, `localRefused` (the `MessageRouter` path's refusals by
  reason).

`verified` alone measures traffic, not the floor: a route that admitted
everything would show the same rising count. The state the floor claims is
read from `refusedByReason` (every refusal explained) and from
`verifiedBySender` — a live same-machine peer with a zero there while it is
sending is the alarm. Not merged across machines (`?scope=pool` leaves this
block per machine; a same-machine route has nothing to merge).

One server-log line per refusal, rate-limited to one per (name, reason)
per minute so a token holder cannot flood the log at zero cost:
`[relay-agent-signature] refuse from=<name> reason=<reason>`, the name
reduced to printable ASCII and cut to 48 characters. No message text, no key
material. The counters are not rate-limited, and neither is the trace:
every refusal — including one whose log line was suppressed — lands in a
bounded in-memory ring (`recentRefusals`, last 200: time, name, reason,
whether the log line was written), served in the same `/health` block, so a
refusal that the log did not print is still a recorded decision, never a
counter increment with no row behind it. The 401 body itself is the
refusal's primary record to the caller.

Degradation reports (`DegradationReporter`, feature
`Threadline.localRouteSignature`, each deduped as stated): one per
`registry-unavailable` episode (cleared when a later read succeeds); one per
sender name when its probe ladder closes (the fifth failed probe); one per
name when an explicit discover replaces its key. These ride
the existing degradation digest; the spec adds no notice source of its own,
so there is no first-detection escalation to gate — the self-discovery step
IS the heal, and every report follows five attempted heals.

## Frontloaded Decisions

1. **Signed set and prefix** — `message` + `transport.{nonce,timestamp,relayChain}`
   under `instar-a2a-local-envelope-v1\n`; `delivery` and `threadSync`
   unsigned, with their effects named (§1).
2. **Canonicalisation** — the existing `AgentTokenManager.canonicalJSON`,
   exported, with the rules and the two bounds listed in §1; signature is
   base64, ≤ 128 characters.
3. **Key source** — the registry entry for the NAME; proven fingerprint =
   `computeFingerprint(publicKey)`, never the stored field; ambiguity = two
   keys under a name or one key under two names (§2).
4. **Self-discovery in the request path, add-only** — one bounded step on
   `unknown-sender` only; a key on record is never replaced by the route;
   doubling backoff 60 s → 16 min, five failed probes per name per process,
   then closed and reported (§3). `discoverLocal` merges instead of
   replacing, so an offline peer's key is never erased by a sweep.
5. **Placement and downstream** — before the loop check; the proven
   fingerprint feeds the trust check, the ledger (verified namespace), the
   thread attribution, the warrants gate and the ack recorder; one registry
   read per request (§4).
6. **Recipient, freshness, replay** — `to.agent` required and must be this agent (`wrong-recipient`); −10 min / +2 min;
   a 12-minute, 4,096-entry nonce cache that refuses at its bound instead of
   evicting; per-process, restart gap stated (§5).
7. **Twelve reasons under one `401 bad-signature`**, with `retryable` and
   `remedy` per row (§6).
8. **Signer never rewrites or lends `from`** — a foreign `from.agent` is sent
   unsigned and refused (§7).
9. **A refusal is terminal on the `MessageRouter` path** — 4xx never drops;
   the drop directory verifies the same signature on pickup; pre-release
   unsigned drops are rejected once, counted (§7).
10. **Capability advertisement** on the unauthenticated threadline health
    (§8).
11. **Live, no flag** — a security floor; the ladder is evidence stages on
    one release, with the operator's acceptance of the mixed-version cost
    recorded in the frontmatter directive (§Rollout, §Maturation plan).

## Open questions

*(none)*

## What it does not do

- It does not bound the drop directory's growth or add a timer to drop
  pickup; pickup stays a boot-time pass. A `MessageRouter` sender whose
  target is unreachable parks envelopes as today, now signed.
- It does not make the presence heartbeat refresh keys; only
  `threadline_discover` (merge, §3) and the add-only self-discovery write
  keys.
- It does not prune the registry. Entries are upserted by name and never
  removed; at ~480 bytes each the 1 MB bound
  is ~2,000 entries, far from today's three. Past the bound every sender is
  `registry-unavailable` (one degradation report), never a silent cliff.
- It does not re-key a peer. A same-machine peer that rotates its identity
  is refused `signature-invalid` on this route until `threadline_discover`
  records the new key; its messages take the relay meanwhile.
- It does not cover `/a2a/inbox`, the other same-machine transport, which
  has its own accept boundary (`a2a-inbox-accept-boundary.md`).
- It does not defend against a process running as the same user. Such a
  process can read every agent's identity file on the machine and sign as
  any of them. The floor closes misattribution by construction (a bug, a
  stale registry, a wrong `from` field, a token holder with no key) and gives
  downstream checks a proven identity; it is not an OS boundary.
- It does not make the key on record stronger than trust-on-first-use over
  loopback (§2): an explicit `threadline_discover` still records whatever
  key the registered port answers with, including a replacement for a name
  already on record (now logged, counted and reported, never silent). The
  standards gate flags this as a Know-Your-Principal exposure, and that is
  accurate; closing it needs a verified re-key authorization, which is the
  verified pairing spec's job (`secure-a2a-verified-pairing.md`), not a
  change this route can make alone. What this spec does is confine the
  unauthenticated re-key to that one deliberate path — the request path can
  only add, never replace.

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Admit or refuse a local-route envelope by signature | invariant | Admitted only when the Ed25519 signature verifies against the registry key for the body's sender name, the signed `to.agent` names this agent, the timestamp is fresh, the nonce is unseen and any body fingerprint equals the proven fingerprint. No mode, no override, no flag. |
| Which key verifies | invariant | The registry entry for the sender name, exactly one distinct 64-hex public key, not also held under another name. Never a key from the body. |
| What downstream reads as the sender | invariant | `computeFingerprint(verifyingPublicKey)`. Every consumer takes it in place of the body-derived value. |
| Whether to self-discover a missing key | invariant | Deterministic: only when no usable key is on record for the name, exactly one running AgentRegistry entry with the name, one loopback health read, one re-verify, doubling backoff from one minute, five failures per name per process. A key on record is never replaced. No judgment call; the anchor is the one discovery already uses. |
| What a `MessageRouter` sender does with a refusal | invariant | A 4xx is terminal (`failed`, reason recorded); only unreachability drops. |
| Whether a dropped envelope is ingested | invariant | Only when its signature verifies under the same rule as the route. |

## Multi-machine posture

Three surfaces, each with its own posture:

- **The signing identity is unified.** On a paired agent the identity key
  is carried to every machine by the pairing exchange (`IdentityManager`
  refuses to mint a second one), so the key that signs on machine A is the
  key that signs on machine B. Nothing in this spec copies or replicates it.
- **The registry entry is machine-local.** Its port and liveness are a
  binding to a process on this host, and the key fact in it was taken from
  that process over this host's loopback. The same-machine route and the
  self-discovery step read the registry of the machine they run on.
- machine-local-justification: physical-credential-locality impossible-because="a loopback port binding, and the per-agent token file that gates it, exist only on the host that owns the process; no vault or replication can make host A's loopback reachable from host B" permanence=permanent
- A unified name→key source (the identity is already unified) would let a
  machine verify a peer it has never discovered locally; that would widen
  the anchor beyond loopback and is deliberately not part of this change.
- **Counters and the replay cache are per-machine operational state**, not
  merged by `?scope=pool`. Nothing here produces a notice, a URL or durable
  state that could double-fire or strand on a topic transfer; a refusal on
  one machine says nothing about another.

The route is token-gated and loopback- or mesh-bound (mesh agents bind the
Tailscale/LAN interfaces); the signature check is the same on both.

## Rollout

Live, no flag, on every agent from the release that carries it. A security
floor that ships dark guards nothing, and the route's consumers (Dawn's
route among them) need the proof to be unconditional to rely on it. The
operator accepted this in the directive recorded in the frontmatter. What it
costs, stated:

- **A mixed-version machine during an update.** Agents on one host update
  independently (the auto-updater ticks every 30 minutes per agent server,
  plus restart dampening), so an updated receiver can face an older
  sender's unsigned envelope for up to one updater interval; an agent that
  does not auto-update (running from source, or pinned) stays unsigned until
  it is updated by hand. For a relay-send sender the message takes the relay
  (judged there under the relay's rules). For a `MessageRouter` sender the
  send fails, is logged with `unsigned`, and is NOT parked — the caller sees
  the failure. The window closes when the sender updates.
- **A receiver that has never discovered the sender** self-discovers on
  first contact (§3). The standing `unknown-sender` cases are a peer the
  AgentRegistry does not list as running, one whose health does not answer,
  or one whose five probes are used up — and the last is reported, not just
  counted. A peer that rotated its identity is refused `signature-invalid`
  until someone re-discovers it deliberately.

## Rollback

None in configuration: a floor with an off switch is not a floor. Rolling
back is reverting the release. The only durable write is the self-discovery
upsert into the registry, which is the same shape a discover writes and
needs no repair.

## Migration parity

- No config field is added. Nothing to migrate.
- CLAUDE.md: one section "A2A local-route signed envelope" in the template
  and in `migrateClaudeMd` (sniff key `A2A local-route signed envelope`),
  listed among the framework-shadowed sections (a Codex or Gemini agent must
  know the 401, its `remedy` field and the self-discovery behaviour).
- Counters on the authed `/health` under `threadline.localRouteSignature`;
  `localEnvelopeSignature: "v1"` on the unauthenticated threadline health.

## Agent awareness

| Section | Content |
|---|---|
| A2A local-route signed envelope | The same-machine route now refuses an envelope that does not carry a valid signature from the key on record for its sender name (`401 bad-signature`; `reason` names which check failed, `remedy` says whether the sender or the receiver must change, `retryable` says whether an identical resend can ever succeed). A receiver that has not met the sender fetches its key itself on first contact (at most five tries per peer per process), so `unknown-sender` now means the peer is not registered as running on this machine, its health did not answer, or those tries are used up. `signature-invalid` or `fingerprint-mismatch` from a known peer means it is signing with a key other than the one on record; the receiver never swaps the key on its own — look at why the peer's identity moved, then run `threadline_discover` deliberately if it should be re-keyed. A `POST /messages/send` to a same-machine agent with a `from` that is not me is refused, by design, and a refused send is never parked in the drop directory. Counters: authed `/health` → `threadline.localRouteSignature`. |

## Tests

- **Unit** (`tests/unit/a2a-local-route-signed-envelope.test.ts`):
  canonicalisation (key order at every level, `undefined` dropped, arrays
  kept, depth and size bounds → `malformed`); sign then verify with the real
  key pair; every reason against a real registry file and a real clock
  (unsigned, malformed, stale past and future, replay, replay-cache-full at
  the bound, wrong-recipient, unknown sender,
  ambiguous by two keys, ambiguous by one key under two names, entry without
  a key, entry with a disagreeing fingerprint, registry unreadable,
  fingerprint mismatch incl. prefix, wrong key, tampered body, tampered
  nonce, tampered relay chain); the proven fingerprint derives from the key,
  not the stored field; self-discovery against a stub health server
  (adds the entry and verifies; merges rather than replaces; a key on
  record is NEVER replaced on a signature failure; doubling backoff; the
  five-probe cap closes the name and files one report); `discoverLocal`
  keeps an offline peer's entry and key and updates an answering peer's; the signer helper with and without an
  identity and with a foreign `from`; the log line reduces the name and is
  rate-limited; migration parity (template section present, migrator adds
  it once).
- **Integration** (`tests/integration/threadline/a2a-local-route-signed-envelope.test.ts`):
  the real route on a real `AgentServer` with a real ledger and registry:
  auth first; each refusal is `401 bad-signature` with its reason and leaves
  no inbox entry, no ledger row and no content window; a signed envelope is
  delivered and the trust check, the ledger (verified namespace) and the
  thread attribution see the proven fingerprint; a real `MessageRouter` with
  the production signer delivers to a second real server, and on a refusal
  fails without writing the drop directory; `pickupDroppedMessages` rejects
  an unsigned drop and ingests a signed one; counters and the health
  advertisement.
- **E2E** (`tests/e2e/threadline/a2a-local-route-signed-envelope-alive.test.ts`):
  two real servers booted the production way (`bootstrapThreadline`, a real
  relay): `/health` reports the floor alive with a signer; the sender's real
  relay-send name path delivers locally and `verified` counts one; a
  hand-rolled unsigned POST is refused and never reaches the router; a
  receiver that has not recorded the sender's key self-discovers it from the
  sender's live health and delivers.
- **Existing tests that post to the route** (23 files) are updated to sign
  through one shared helper (`tests/helpers/localEnvelope.ts`: mint a sender
  key pair, record it in the receiver's registry, sign) — the same thing
  every real sender does.

## Maturation plan

- **test-agent-live:** the e2e tier above (two real servers, real relay, the
  production sender paths) plus a `test-as-self` deploy of the release
  candidate before merge: a same-machine send between the throwaway agent
  and the development agent verifies; an unsigned hand-rolled POST is
  refused; a never-discovered receiver self-discovers.
- **dev-agent-live:** the release lands on the development agent (Echo)
  first by the normal update path; over the following 24 hours the authed
  `/health` block must show `verified` rising per live same-machine peer in
  `verifiedBySender`, every `refused` explained by a reason, and zero
  `signature-invalid` / `fingerprint-mismatch` from a known peer.
- **fleet:** the same release, no separate flip — the verification is the
  same code on every agent class. The fleet evidence is the degradation
  digest: no `registry-unavailable` or repeated self-discovery failure
  reports in the first week.
- **graduation criterion:** 24 hours on the development agent with the
  dev-agent-live numbers as stated, then one week on the fleet with no
  degradation report attributable to this feature. A `signature-invalid` or
  `fingerprint-mismatch` from a known same-machine agent at any point is a
  bug to fix, not a tuning question.
- **dark-window:** none. There is no dark or dry-run phase: a dark floor
  guards nothing, and the operator's directive (frontmatter) accepted the
  mixed-version cost in exchange for Dawn's route switching on against a
  real proof. What is graduated is evidence, not enforcement.

---
title: A2A local-route signed envelope — the same-machine route proves its sender
slug: a2a-local-route-signed-envelope
date: 2026-10-09
author: echo
parent-spec: a2a-local-route-trust.md
depends-on: a2a-inbound-id-ledger.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "The same-machine route takes the sender's name from the request body and acts on it. This change lets the route prove that name before anything downstream reads it: the envelope carries an Ed25519 signature that must verify against the public key this agent has on record for that name. When the check is enforcing, an envelope that cannot prove its sender is refused before it is recorded anywhere, and that refusal is terminal on every sender path, including the offline drop directory."
binding-standards: ["A Refusal Stays a Refusal — conservation of negative outcomes", "Structure > Willpower", "No Manual Work (user or agent)", "The Agent Is Always Reachable", "Verify the State, Not Its Symbol", "A Dark Feature Guards Nothing"]
eli16-overview: a2a-local-route-signed-envelope.eli16.md
approved: true
approved-by: "operator directive for CMT-706 — Justin, Telegram topic 9210, 2026-10-09 (“please proceed as you recommend” / “go”); rollout shape (dev-gated, dry-run first) set by the supervising session's builder brief for ACT-067, 2026-10-10"
review-convergence: "2026-10-10T20:53:27.395Z"
review-iterations: 6
review-completed-at: "2026-10-10T20:53:27.395Z"
review-report: "docs/specs/reports/a2a-local-route-signed-envelope-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 0
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
trust level stated to the receiving session — acts on that text. This spec
proves the name for the first two (the ones that admit or refuse); the
others are listed in "What it does not do".

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

## What exists (verified on `main` = c5a0f2563)

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
  write REPLACES the whole file with the agents reachable at that instant.
  `discoverLocal()` runs
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
  used for the drop HMAC; `MessageRouter.ts` carries an identical second
  copy (exported, used for the cross-machine signature). Neither is bounded
  in depth or size, and `express.json` accepts 12 MB.
- **The presence heartbeat rewrites the registry from a stale snapshot.**
  `heartbeatTick` loads `known-agents.json`, awaits one ping per entry, then
  saves the list it loaded. Anything another writer added in between is
  lost. This spec therefore never writes that file.
- **A drop is not always preceded by a POST.** `routeCrossAgentLocal` calls
  `dropMessage` directly when the target has no `running` AgentRegistry
  entry, and `relayToAgent` returns before the POST when the target's token
  is missing. `MessageRouter.send` sets `transport.nonce` to
  `<random UUID>:<ISO time>`.
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

### 1. The signed envelope (wire format)

The sender adds ONE top-level field to the envelope: `signature`, a base64
string (88 characters) of the 64-byte Ed25519 signature, made with the
sender's identity private key, over

```
UTF-8( "instar-a2a-local-envelope-v1\n" + canonicalJSON({ message, transport: { nonce, timestamp, relayChain, originServer, originTopicId } }) )
```

`canonicalJSON` is the deep-key-sorting canonicaliser exported from
`AgentTokenManager` (object keys sorted by UTF-16 code unit at every level,
no whitespace, `undefined` members omitted from objects and rendered `null`
inside arrays, strings and numbers exactly as `JSON.stringify` renders
them). The module does not add a third copy; it wraps that one:
`localEnvelopeSignedBytes` first JSON-round-trips the signed set
(`JSON.parse(JSON.stringify(...))`), so the sender signs exactly what the
wire will carry (a `Date` or a `toJSON` object is already a string) and the
receiver canonicalises what `express.json` parsed. Two bounds, both
answered `malformed`: nesting deeper than 64 levels (checked BEFORE the
round-trip, so a hostile body never reaches a recursive serialiser) and a
signed set over 1 MB of UTF-8.

`transport.nonce` must be a non-empty string of at most 256 characters,
fresh per POST; both senders build it from a random UUID (122 random bits).
**A retry is a new envelope:** a new nonce, a new timestamp and a new
signature, even for the same `message.id`. Re-posting the same signed bytes
is `replay` once the first copy passed verification (whatever happened to it
afterwards), so a sender never relies on re-posting; `retryable` in §6 is
permission to retry the message as a new envelope.

The prefix is domain separation: the other preimages signed with the identity
key (the relay envelope, which begins `{`; agent-signature provenance, which
begins `asp1\n`; pair-verify, `threadline-pair-verify-v1`) cannot begin with
it, so a signature made for this route verifies nowhere else and vice versa.
The signed set covers the whole `message` (id, from, to, type, priority,
subject, body, threadId, createdAt, resend) and every transport field a
sender sets: the nonce, the timestamp, the relay chain (it decides a 409),
`originServer` and `originTopicId` (absent members are omitted, as
`canonicalJSON` omits `undefined`). Unsigned: `delivery` (the receiver's own
bookkeeping after admission), the top-level `threadSync` (an advisory hint
the receiver cross-checks and never acts on), and `transport.hmac` /
`hmacBy` / the cross-machine `signature` fields, which are added after
signing. `schemaVersion` stays `1`: the field is additive and a receiver
that predates this spec ignores it.

**Test vector.** A second implementation (Dawn's sender is a separate
codebase) must reproduce the signed bytes exactly. The unit test file
carries a fixed vector — a fixed 32-byte private key, a fixed envelope with
non-ASCII text, a nested object body and an absent `originTopicId`, the
exact signed bytes as hex and the resulting signature — and the PR report
quotes it. Numbers and string escapes are whatever ECMAScript
`JSON.stringify` produces; a sender in another language must match that
(integers and ordinary strings in practice — the envelope carries no
floats).

A complete signed envelope on the wire:

```json
{
  "schemaVersion": 1,
  "message": {
    "id": "…", "from": { "agent": "echo", "session": "…", "machine": "…", "fingerprint": "<32 hex, optional>" },
    "to": { "agent": "dawn", "session": "best", "machine": "local" },
    "type": "request", "priority": "medium", "subject": "…", "body": "…",
    "threadId": "…", "createdAt": "<ISO-8601>"
  },
  "transport": { "relayChain": [], "originServer": "…", "nonce": "<string>", "timestamp": "<ISO-8601>" },
  "delivery": { "phase": "sent", "transitions": [], "attempts": 0 },
  "signature": "<base64 of 64 bytes>"
}
```

Why a bespoke format and not RFC 9421 HTTP Message Signatures or a
unix-socket peer credential: the signature has to survive outside HTTP (the
same envelope is parked as a file in the drop directory and checked there),
and a peer credential identifies a user id, which every agent on the machine
shares. Signing the raw request bytes instead of a canonical form would
avoid canonicalisation but could not be re-checked on a drop file, whose
bytes the sender rewrites (`delivery`, `hmac`).

Module: `src/threadline/localEnvelopeSignature.ts` — the signed bytes, sign,
verify, the registry key lookup, the first-contact key cache, the verdict,
the replay cache, the mode resolver, the log line, and ONE process-level
counter object (the route, `MessageRouter` and drop pickup all write to it;
`/health` reads it).

### 2. Configuration: dev-gated, dry-run first

One block, read live per request (no restart), the same shape as
`threadline.localRouteTrust`:

```
threadline.localRouteSignature: { enabled?: boolean, dryRun?: boolean }
```

- `enabled` omitted ⇒ the development-agent gate decides: live on a
  development agent, off on the fleet. Registered in `DEV_GATED_FEATURES`.
- `dryRun` defaults TRUE; only an explicit `false` leaves it.

| Mode | When | Receiver behaviour |
|---|---|---|
| `off` | `enabled` resolves false | The route does not look at `signature`. Today's behaviour, with one exception: a request that carries the requirement header (§4) is refused `not-enforcing`. |
| `dry-run` | enabled, `dryRun` not `false` | Every envelope is verified (§3–§5) and the verdict is counted and logged (`would-refuse`). Nothing downstream reads the verdict, nothing is refused (except a request carrying the requirement header, §4), and no durable state is written (only the audit log, §9). The in-memory caches (first-contact keys, probe backoff, replay) fill exactly as they would when enforcing and carry across a flip to enforcing, since both modes run the same check. The one observable difference from `off`: a SIGNED envelope from a name with no key on record can wait up to 2.5 s on the first-contact probe (§3). |
| `enforcing` | enabled, `dryRun: false` | An envelope that fails is refused pre-admission (§6). An envelope that passes hands its PROVEN fingerprint downstream (§4). |

**The config key that turns verification on is
`threadline.localRouteSignature.enabled: true`, and the one that makes it
refuse is `threadline.localRouteSignature.dryRun: false`.**

**Senders are not gated.** Both senders always sign when they have an
identity (§7), on every agent, whatever the mode: the field is additive, an
old receiver ignores it, and a receiver in dry-run needs signed traffic to
measure anything. The mode is resolved once per request.

### 3. Key source: the registry, by name; identity derived from the key

The receiver resolves `message.from.agent` (compared lower-cased) through the
registry to the entries with that name that carry a 64-hex `publicKey`.
Exactly one distinct key must remain: zero → `unknown-sender` (after the
first-contact probe, below); more than one distinct key under the name, or the one
key also recorded under a different name (a cloned agent home) →
`ambiguous-sender`.

The entry's public key is the verification key, and the **proven fingerprint
is always `computeFingerprint(publicKey)`**; the entry's stored `fingerprint`
field is never read. The body never picks the key. When the body carries
`from.fingerprint` it must equal the proven fingerprint in full (32 hex,
lower-cased; a prefix is a mismatch), else `fingerprint-mismatch`.

**What this proves, stated honestly.** The key on record was taken on
trust-on-first-use from an unauthenticated loopback endpoint at the port the
AgentRegistry named for that name. The signature proves continuity with the
process that answered there when the key was recorded, not identity in a
stronger sense. That is the anchor same-machine discovery already rests on.
It closes misattribution by construction (a wrong `from`, a process holding
the token but no key) and gives downstream checks a value derived from a
verified key.

**First contact: the receiver fetches the key it is missing, into memory.**
A receiver that has no key on record for a sender does not wait for someone
to run `threadline_discover`. When the registry holds no usable key for the
name, the verifier consults a process-local *first-contact cache* (name →
public key), and if that is empty too it fills it with one bounded probe,
then verifies once:

1. Exactly one `running` AgentRegistry entry must match the name (none →
   `unknown-sender`; two → `ambiguous-sender`). Only such a name gets a slot
   in the probe table, so made-up names cost one AgentRegistry read and no
   state.
2. `GET http://localhost:<port>/threadline/health`, 2.5 s for the whole
   exchange. The answer must say `protocol: 'threadline'`, carry a 64-hex
   `identityPub`, name the same agent (`agent` equals the sender name,
   lower-cased) and, when it carries `fingerprint`, that must equal
   `computeFingerprint(identityPub)`. Anything else is a failed probe.
3. The key goes into the first-contact cache, with one log line
   (`[relay-agent-signature] first-contact key for <name> fp=<12 hex>`), so
   a key taken on first contact is always visible. The cache records what
   the name's registered port ADVERTISED; it is the envelope's signature
   that then proves the sender holds it. An envelope that does not verify
   against a cached key is `signature-invalid` and changes nothing: it does
   not evict the key, does not trigger a probe and does not count against
   the name, so a forged envelope cannot lock the real sender out. **Nothing is written to
   `known-agents.json`**: the probe mutates no registry, routing or
   trust-profile state and cannot race the heartbeat. (When enforcing, the
   fingerprint proven with that key does feed the current request's trust
   check and ledger key, §4.)
4. One probe per name at a time: concurrent requests for the same name await
   the same probe.

The registry always wins: the cache is read only when the registry has no
usable key for the name, so a later `threadline_discover` supersedes it.
The "one key under two names" rule covers both sources: a key is
`ambiguous-sender` if the registry or the cache holds it under any other
name, checked when a probed key is about to be cached and at every verify.
A probe whose answer is well-formed but whose key is already held under
another name is a FAILED probe (not cached, backoff, counts toward the
five), so a colliding name cannot be probed on every message.
**The verifier never replaces a key it holds** — not one in the registry and
not one in the cache. `signature-invalid` and `fingerprint-mismatch` are
never a trigger to probe: adopting whatever answers on the port today would
let a new process inherit a known name. How long the pin lasts, stated
plainly: a registry key lasts until the next `threadline_discover` (which
re-reads every peer's key from its port); a cached key lasts until this
process restarts.

Brakes: a successful probe ends probing for that name. After a failure the
name backs off, doubling (60 s, 2, 4, 8, 16 min), at most five failed probes
per process; then the name is closed until restart or until the key arrives
through `threadline_discover`, and ONE degradation report names it
(`Threadline.localRouteSignature`). The probe table holds at most 64 names;
past that, no probe. A receiver whose peer does not serve
`/threadline/health` at all (no handshake manager) ends in the five-probe
close and its one report. Cheap checks run first (`unsigned`, `malformed`,
`wrong-recipient`, `stale` — no I/O), so unsigned traffic never probes.

### 4. Placement, and what reads the verdict

The check runs after the bearer-token check and the envelope-shape check, and
before the relay-chain loop check, the trust check, the content window and
the ledger commit. Auth stays first: a wrong token answers `401 Invalid or
missing agent token` whether or not the envelope is signed. The registry file
is read once per request for this check.

- **dry-run:** nothing downstream changes.
- **enforcing:** a refused envelope leaves no ledger row, holds no content
  window, reaches no inbox and is attributed to no thread. For an admitted
  envelope the proven fingerprint replaces the name-resolved registry
  fingerprint (`senderRegistryFp`) — the value the local-route trust check
  and the inbound-id ledger's `registry:` key already consume. The ledger
  namespace does not change.
- **both live modes:** the route's success answer gains
  `signature: { mode, verified: <bool> }`, so a sender holding the token
  learns from the answer itself whether its envelope was proven and whether
  the receiver would have refused it otherwise.

**A sender can require the proof.** A request carrying the header
`X-Instar-Require-Signature: v1` is refused before admission unless this
receiver is enforcing: in `off` or `dry-run` it answers `401 bad-signature`
with reason `not-enforcing` (retryable, remedy receiver) and records
nothing. So a consumer that must never deliver an unproven message (Dawn's
backup route) sends the header on every POST and gets either a proven
delivery or a refusal, whatever the receiver's mode did between its health
read and its send. A receiver that predates this spec ignores the header,
which is why the consumer first checks that `/threadline/health` carries
`localEnvelopeSignature` at all (§8). The header check sits right after the
token check and the envelope-shape check. `not-enforcing` is always a real
refusal: it counts in `refused` and `byReason` in every mode, and writes an
audit row when the mode is not `off`. One limit, stated: if the receiver is
replaced by an older release between the consumer's health read and its
POST, that release ignores the header and delivers; the consumer sees it in
the answer (no `signature` block) and switches off. Closing that needs a
separate endpoint old releases do not have, which this spec does not add.
Instar's own two senders do not send the header: their messages are meant
to arrive in every mode.

### 5. Recipient, freshness, replay

- **Recipient.** `message.to.agent` is required and must equal the receiver's
  `projectName` (lower-cased), else `wrong-recipient`. `to` is inside the
  signed bytes; without the check a holder of C's token could replay A's
  envelope for B to C. Both real senders set it.
- **Freshness.** `transport.timestamp` (signed) must parse as an instant no
  more than 10 minutes in the past and 2 minutes in the future of the
  receiver's clock (one machine, one clock), else `stale`.
- **Replay.** An in-memory cache of `(proven fingerprint, nonce)`, recorded
  when an envelope passes verification (in both live modes, whatever happens
  to it downstream), with a 12-minute lifetime (longer than any fresh
  envelope can live). A second envelope with the same pair is `replay`.
  Bounds: 512 entries per fingerprint inside 4,096 overall. At either bound
  the receiver does not evict: that sender (or, at the overall bound, every
  sender) is `replay-cache-full` until entries age out. That is the bound
  doing its job, so it is counted (`byReason`) and logged, not reported as a
  degradation. A sender needs about 0.7 messages a second
  for twelve minutes to fill its own share, and fills only its own. The
  cache is per process: an envelope captured in the ten minutes before a
  restart can be admitted once in the ten minutes after it. Stated, not
  fixed: a durable write per message to close a minutes-long window is not
  worth it inside the threat model. No real sender re-POSTs the same nonce
  (the relay-send fall-through goes over the relay; `MessageRouter` does not
  retry), so a retry the ledger asked for arrives with a new nonce.
- **Across machines.** A paired agent has one identity key on every machine,
  and the replay cache is per machine, so an envelope from A to B is valid
  at B on each of B's machines for ten minutes — to a caller who also holds
  that machine's token for B.

### 6. Refusal (enforcing only)

HTTP 401 with

```
{ "error": "bad-signature", "refused": true, "retryable": <bool>, "remedy": "sender" | "receiver", "reason": "<reason>" }
```

| `reason` | When | `retryable` | `remedy` |
|---|---|---|---|
| `unsigned` | no `signature` field | false | sender |
| `malformed` | `signature` is not base64 of 64 bytes, `transport.nonce` is not a non-empty string of at most 256 characters, `transport.timestamp` is not a string, `message.from.agent` is not a non-empty string, or a canonicalisation bound is exceeded | false | sender |
| `stale` | timestamp outside −10 min / +2 min | false | sender |
| `wrong-recipient` | `message.to.agent` absent or not this agent | false | sender |
| `unknown-sender` | no usable key on record for the name and the first-contact probe could not fetch one | true | receiver |
| `ambiguous-sender` | two keys under the name, the key under two names, or two running AgentRegistry entries with the name | true | receiver |
| `registry-unavailable` | the registry file exists but is unreadable, unparseable or over 1 MB | true | receiver |
| `fingerprint-mismatch` | the body's `from.fingerprint` differs from the proven fingerprint | false | sender |
| `signature-invalid` | Ed25519 verification fails against the key on record | false | sender |
| `replay` | the (fingerprint, nonce) pair was already admitted | false | sender |
| `replay-cache-full` | the replay cache is at a bound (§5) | true | receiver |
| `not-enforcing` | the request carries `X-Instar-Require-Signature: v1` and this receiver is `off` or `dry-run` (answered in every mode, the one refusal that does not need the check enabled) | true | receiver |

`retryable` means the same message, sent as a new envelope, may succeed
later because the receiver's state can change. The body carries no key material and no registry
contents. A 401 from this route is already in the backup-routes
non-admission set, so a relay-send fall-through after it is unmarked
(nothing was recorded) and the message takes the relay, judged there.

If the verifier itself throws: dry-run counts `errors` and delivers; enforcing
answers `503 { error: "signature-check-unavailable", refused: true,
retryable: true }`. A 503 is not in the non-admission set, so that
fall-through copy is marked as a resend; over-marking is the direction the
backup-routes spec calls safe.

### 7. The senders sign, and a refusal is terminal

- **One signer.** `createAgentLocalEnvelopeSigner(localAgent, stateDir)` in
  the module builds the signer over the Threadline identity
  (`src/threadline/client/IdentityManager`, constructed with the agent's
  state directory — NOT the machine identity, which is a different key),
  and reads the identity at each sign, because `MessageRouter` is built
  before the Threadline bootstrap that may first create it.
  `server.ts`, the relay-send name path and the tests all use it.
- **The relay-send name path** signs immediately before the POST.
- **`MessageRouter`** takes an optional `envelopeSigner` in its config.
  `routeCrossAgentLocal` signs ONCE, before it looks the target up — so the
  envelope is signed whether it is then POSTed or goes straight to the drop
  directory (target not registered, token missing). `dropMessage` changes
  only `delivery` and `transport.hmac` / `hmacBy`, all outside the signed
  set. The signer never rewrites `from` and never lends this agent's
  signature to another name: `from.agent` must equal the router's
  `localAgent` (lower-cased) or the envelope is sent unsigned (counted
  `signRefusedForeignFrom`).
- **No identity** (none on disk, or locked): the envelope goes unsigned,
  counted `signFailures`, with one degradation report per process — an
  enforcing peer will refuse everything this agent sends locally.
- **An explicit refusal does not drop.** Today `relayToAgent` returns
  `response.ok`, and any `false` writes the envelope to the drop directory,
  where the target ingests it at its next boot with no check — a refusal
  laundered into a delivery. `relayToAgent` now returns `accepted`,
  `refused` (ANY status whose JSON body says `refused: true`: this route's
  401 and 503, the local-route trust 403 and 503) or `unreachable`
  (everything else, exactly as today — including an answered error without
  that flag, such as the token 401 or a 500). A `refused` send fails: phase
  `failed`, the receiver's `error` / `reason` / `retryable` on the delivery
  transition, one log line, counted `localRefused`, nothing in the drop
  directory. That holds for retryable refusals too: the receiver answered
  and said no; the caller sees the failure and can send again. Only
  receivers with an enforcing check send `refused: true`, so nothing changes
  for anyone else.
- **Drop pickup applies the signature check, after its own.** The existing
  checks run first and delete as today (bad structure, an id already in the
  store, a missing or invalid HMAC). Then, by mode — `server.ts` resolves it
  from config and passes it with the state directory and the agent name:
  - `off`: as today.
  - `dry-run`: each drop is verified and counted (`dropsVerified`, or
    `wouldRefuse` + `byReason`), then ingested as today.
  - `enforcing`: a drop is ingested only if its signature verifies — the
    route's rule without the freshness bound and the replay cache (a drop is
    old by nature; pickup already skips an id in the store). An unproven
    drop is left in place, counted `dropsHeld`; the check never deletes a
    drop on its first look.
- **Two passes per boot, the second one able to fetch keys.** The boot pass
  runs before any peer is listening (after a reboot every agent is `running`
  in the AgentRegistry and none answers yet), so it verifies against the
  registry only and never probes: a boot-time probe would fail for a reason
  that says nothing about the peer and would start that peer's backoff
  against its live traffic. If the boot pass holds anything, ONE more pass
  runs five minutes later, with the first-contact probe allowed. Only that
  second pass expires: a drop still unproven and older than 7 days (file
  modification time) is deleted, counted `dropsExpired`. The second pass
  files one degradation report when it leaves anything held or expires
  anything: the counts and up to 16 sender names, each reduced as in §9. So
  a held drop is reported at most once per boot — including after a long
  outage, when it is already days old the first time this agent sees it.
  A verifier error at pickup counts `errors`, holds the drop when enforcing
  and ingests it in dry-run; it never reaches pickup's deleting catch.
  Deletion goes through the existing `unlinkSafe` (`SafeFsExecutor`). The
  second pass is the same pickup function on an `unref`'d timer that is
  cleared at shutdown. Nothing is retried after it until the next boot. The
  registry is read once per pass. The cost, stated: the registry is filled
  only by `threadline_discover`, so on an ordinary restart most senders are
  known only through first contact, and an enforcing receiver ingests their
  parked messages five minutes after boot, not at boot. In dry-run no second
  pass runs, so a boot-pass `unknown-sender` count for drops does not predict
  what enforcing would hold.

### 8. Capability advertisement

The unauthenticated `GET /threadline/health` gains

```
"localEnvelopeSignature": { "version": "v1", "mode": "off" | "dry-run" | "enforcing" }
```

`ThreadlineEndpointsConfig` gains an optional mode callback, passed where
the routes build the endpoints; an agent with no handshake manager mounts no
`/threadline/health` and so advertises nothing (a consumer treats that as
`off`).

A same-machine consumer (Dawn's backup route) reads the field's presence as
"this receiver understands the requirement header" and `mode ===
"enforcing"` as the hint to switch on, then sends
`X-Instar-Require-Signature: v1` on every POST (§4), which makes the
guarantee per request; the token-authenticated answer also carries
`signature.mode` — the health endpoint is
served to anyone who can reach the port and the mode can change between the
read and the send. The mode is not a secret; on a mesh-bound agent the
health endpoint shows it to LAN and tailnet peers without a token.

### 9. Counters and logging

In memory, per machine, on the authed `/health` under
`threadline.localRouteSignature`: `mode`; receiver — `verified`,
`verifiedBySender` (name → count, at most 64 names), `wouldRefuse`,
`refused`, `byReason` (the twelve reasons; would-refuse and refused share
it, the mode says which), `errors`, `probed`, `probeFailed`, `probeClosed`,
`firstContactKeys`, `replayCacheSize`, `dropsVerified`, `dropsHeld`,
`dropsExpired`; sender — `signerAvailable` (evaluated at read time),
`signed`, `signFailures`, `signRefusedForeignFrom`, `localRefused`; and
`auditWriteFailures`. The
counters are one process-level object in the module, because the route,
`MessageRouter` and boot-time drop pickup all write to it. The block also
carries `since` (when this process started counting).

The counters do not survive a restart, a development agent restarts on
every update, and the server log is cut to its last megabyte at boot (a few
hours on Echo). So the rollout evidence has its own carrier: while the mode
is not `off`, every verdict — route and drop pickup, pass and non-pass —
appends one row to `{stateDir}/logs/relay-agent-signature.jsonl`:

```
{ "ts": "<ISO>", "source": "route" | "drop", "mode": "dry-run" | "enforcing", "outcome": "verified" | "would-refuse" | "refused" | "held" | "expired", "from": "<reduced name>", "reason": "<reason, when not verified>" }
```

Metadata only (no message text, no key, no nonce), mode 0600 (re-applied
after each rotation, because the rotation helper rewrites the file at the
default mode), appended with the existing `maybeRotateJsonl` bound (2 MB,
keep the newer half — about 6,000 rows), never throwing into the verdict. A
verifier error writes a row too (`reason: "error"`). A failed append is
counted (`auditWriteFailures` on `/health`).

A 24-hour reading is a count of rows whose `ts` falls in the window. The
reading is UNKNOWN, and blocks the flip, when the file's oldest row is newer
than the start of the window (sustained traffic above roughly four verdicts
a minute rotates a day out of the file) or when `auditWriteFailures` is not
zero. Rows are only written while the agent is up and the mode is not
`off`, so "no bad row" alone could pass on silence; the per-peer floor of
20 `verified` rows in the same window is what makes the zero-criteria
mean something. This is the one file the check writes; it is an audit log, not state,
and nothing reads it back at runtime.

One server-log line per non-passing verdict, rate-limited to one per (name,
reason) per minute: `[relay-agent-signature] would-refuse|refuse from=<name>
reason=<reason>`, the name reduced to printable ASCII and cut to 48
characters. The limiter is keyed on that reduced name and holds at most 256
keys (past that, lines share one bucket). No message text, no key material.
Counters are never rate-limited.

## Frontloaded Decisions

1. **Signed set, prefix, encoding** — `message` +
   `transport.{nonce,timestamp,relayChain,originServer,originTopicId}` under
   `instar-a2a-local-envelope-v1\n`; the `AgentTokenManager.canonicalJSON`
   export behind a bounded JSON round-trip; base64 in a top-level
   `signature`; non-empty nonce; a fixed test vector in the unit tests (§1).
2. **Gate** — `threadline.localRouteSignature.{enabled,dryRun}`, dev-gated,
   dry-run default, read live, resolved once per request; three modes (§2).
   Senders always sign.
3. **Key source** — the registry entry for the name; proven fingerprint
   derived from the key; ambiguity rules (§3).
4. **First contact** — a probe into a process-local cache, never a registry
   write; the answer must name the agent; only an absent, ill-formed or
   colliding answer counts as a failed probe, never a bad signature; key uniqueness across registry and
   cache; single-flight; five-probe doubling ladder, 64 names; in both live
   modes and in the second drop-pickup pass, never the boot pass (§3, §7).
5. **Placement and downstream** — before the loop check; enforcing replaces
   `senderRegistryFp` with the proven fingerprint; the ledger namespace is
   unchanged; the success answer carries `signature: { mode, verified }` (§4).
6. **Recipient, freshness, replay** — required `to.agent`; −10 / +2 min;
   nonce recorded at verification; 12-minute cache, 512 per sender inside
   4,096, refuses at a bound (counted, not a degradation) (§5).
7. **Twelve reasons under one `401 bad-signature`** (eleven verdicts and
   `not-enforcing` for the requirement header), `retryable` + `remedy`
   per row; a throwing verifier is a retryable 503 when enforcing (§6).
8. **`refused: true` is terminal on the `MessageRouter` path at any status,
   retryable or not**; any other answered error drops as today;
   `routeCrossAgentLocal` signs before the POST-or-drop branch; one signer
   factory over the Threadline identity (§7).
9. **Drop pickup** — existing checks first; enforcing holds every unproven
   drop; a boot pass without probes and one second pass five minutes later
   with them; only the second pass expires, at 7 days (§7).
10. **Advertisement and requirement** — `localEnvelopeSignature: { version,
    mode }` on the unauthenticated threadline health; a sender that needs
    the proof sends `X-Instar-Require-Signature: v1` and is refused
    `not-enforcing` otherwise (§4, §8).
11. **Counters and evidence** — one process-level counter object with
    `since`; one metadata-only row per verdict in
    `logs/relay-agent-signature.jsonl` as the evidence that survives
    restarts; an uncovered window reads as unknown (§9).
12. **This build ends with Echo in dry-run.** The flip to enforcing on Echo
    is Echo's to make on the dev-agent-live numbers, tracked as ACT-074
    (Maturation plan).

## Open questions

*(none)*

## What it does not do

- It does not enforce on the fleet, or anywhere, until someone sets
  `dryRun: false`. Until then the route proves nothing to a consumer, and
  the advertisement says so (`mode`).
- It does not give the drop directory the local-route trust check. Pickup
  ingests a parked envelope without it today, so a sender the trust check
  would refuse online is admitted after a receiver outage. That is a fault
  of the foundation this spec builds on, found in its review; so is
  `dropMessage` joining an unsanitised `to.agent` into a path. (recorded on ACT-064)
- It does not tell the sender what happened to a parked message. This is
  this spec's own cost, not the foundation's: today every valid drop is
  ingested, and enforcing pickup creates two new outcomes — held, and
  expired after 7 days — while the sender's store still says `queued`. The
  receiver reports them (§7); the sender learns nothing. (recorded on ACT-064)
- It does not carry the proven fingerprint to the thread-attribution read,
  the warrants-reply gate or the ack recorder (they keep today's inputs),
  does not promote a proven local sender into the inbound-id ledger's
  verified namespace, and does not change `discoverLocal`, which still
  replaces every recorded key on any `threadline_discover`. (recorded on ACT-072)
- It does not re-key a peer. A same-machine peer that rotates its identity
  is `signature-invalid` until `threadline_discover` records the new key;
  when enforcing, its relay-send messages take the relay meanwhile and its
  `MessageRouter` sends fail until then (that path has no relay fallback;
  the caller sends again after the fix).
- It does not bound the drop directory beyond the 7-day expiry of held
  drops, and adds no recurring timer to pickup (one second pass per boot).
- It does not cover `/a2a/inbox`, which has its own accept boundary
  (`a2a-inbox-accept-boundary.md`).
- It does not defend against a process running as the same user, which can
  read every agent's identity file and sign as any of them. It is not an OS
  boundary, and the key on record is no stronger than trust-on-first-use
  over loopback; a verified re-key is the verified pairing spec's job
  (`secure-a2a-verified-pairing.md`).

## Decision points touched

| Decision point | Class | Floor + arbiter |
|---|---|---|
| Refuse a request that requires the proof when not enforcing | invariant | Header present and mode is not `enforcing` → 401 `not-enforcing`, before admission. No judgment. |
| Admit or refuse a local-route envelope by signature (enforcing) | invariant | Deterministic: the Ed25519 signature verifies against the one registry key for the sender name, the signed `to.agent` names this agent, the timestamp is fresh, the nonce is unseen, any body fingerprint equals the proven one. No judgment among competing signals: a signature verifies or it does not. |
| Which mode applies | invariant | Config only: the development-agent gate for `enabled`, an explicit `false` for `dryRun`. |
| Which key verifies | invariant | The registry entry for the sender name, exactly one distinct 64-hex key, not held under another name. Never a key from the body. |
| Whether to probe for a missing key | invariant | Only when neither the registry nor the cache holds a key for the name, exactly one running AgentRegistry entry, one loopback read whose answer names the agent, the five-probe ladder. A held key is never replaced. |
| What a `MessageRouter` sender does with `refused: true` | invariant | Terminal (`failed`, reason recorded) at any status; only an outcome classified `unreachable` drops (no answer, or an answered error without the flag, as today). |
| Whether a dropped envelope is ingested (enforcing) | invariant | Only when its signature verifies; otherwise held in place, deleted by the second pass once older than 7 days. |

## Multi-machine posture

- **The signing identity is unified.** On a paired agent the identity key is
  carried to every machine by the pairing exchange, so the key that signs on
  machine A signs on machine B. Nothing here copies or replicates it.
- **The registry entry, the first-contact cache, the replay cache, the
  probe table, the counters and held drops are machine-local.** The route is
  a same-machine route: each of these describes processes and files on this
  host.
- machine-local-justification: hardware-bound-resource impossible-because="the name-to-port binding, the per-machine agent token, the drop directory and the in-memory caches describe processes and files on one host and cannot be served from another machine" permanence=permanent
- **The config block is per machine**, like `localRouteTrust`. Two machines
  of one agent may be in different modes; each advertises its own `mode`,
  and a same-machine consumer reads the machine it is on.
- Nothing here produces a notice, a URL or durable state that could
  double-fire or strand on a topic transfer.

## Verify the State, Not Its Symbol

| Symbol | State it claims | Corroboration | When unmeasurable |
|---|---|---|---|
| A valid signature under the key held for the name | The envelope was written by the holder of the key recorded for that name, for this agent, in the last ten minutes | The key is the receiver's own record (registry, else a probe whose answer named the agent), never the body's; `to` and the timestamp are inside the signed bytes; the nonce cache | Registry unreadable → `registry-unavailable`; verifier throws → dry-run delivers and counts `errors`, enforcing refuses retryable (a relay-send falls through to the relay; a `MessageRouter` send fails and the caller sends again) |
| `mode: "enforcing"` on the health endpoint | This receiver refuses unproven envelopes | The authenticated answer to the consumer's own POST carries `signature.mode`, resolved for that request | Field absent → the receiver predates this spec; a consumer treats absent as `off` |
| `verified` rows in the audit log over 24 hours | Signed traffic from that peer was checked and passed in that window | Each row is written when the verdict is made and carries its own time; `signed` on the sender counts the same messages from the other end | The file's oldest row is newer than the window start → unknown, blocks the flip. Feature off → no rows, and `/health` reports `mode: "off"` |
| A key in the first-contact cache | The named agent's registered port advertises that key | The answer named the agent and its fingerprint agreed; the key is not held under another name; the log line records it. Holding the key is proven per envelope, by the signature | Probe fails → `unknown-sender`, backoff, at most five tries, one report |
| `signerAvailable: true` | This agent's local sends leave signed | `signed` rising with sends; `signFailures` and `signRefusedForeignFrom` count the ones that did not | No identity → `false`, one degradation report |
| The mode drop pickup used | Drops were checked under the advertised mode | Each pass resolves the mode when it runs and logs it; the advertised mode is live per request | A flip after the second pass applies to pickup at the next boot |

## Maturation plan

- **test-agent-live:** the e2e tier (two real servers booted the production
  way): dry-run delivers an unsigned envelope and counts it; enforcing
  refuses it with the 401; the production sender delivers signed; a receiver
  with no key on record probes and delivers.
- **dev-agent-live:** this release puts Echo in dry-run. After 24 hours with
  live same-machine traffic, read from `logs/relay-agent-signature.jsonl`
  (rows in the window; an uncovered window is unknown and blocks): at least
  20 `verified` rows for each peer that will be enforced against, no
  `signature-invalid` / `fingerprint-mismatch` row from a known peer, and no
  `unsigned` row in those 24 hours — or
  each remaining unsigned sender named in the ACT-074 record as accepted
  (enforcing applies to every sender, so an unsigned one moves to the relay
  or fails). This is a precondition of the flip, not advice. Dawn's
  sender is a separate codebase (the-portal): her route signs with the wire
  format in §1 before Echo enforces, or her messages show as `unsigned`.
  Then Echo sets `dryRun: false` on itself (its own inbound route; the relay
  still carries anything refused) and Dawn's backup route switches on
  against `mode: "enforcing"`.
- **fleet:** `off`. A later release turns the fleet default to dry-run and
  then enforcing, after a week of Echo enforcing with no degradation report
  from this feature. That is its own change with its own review.
- **graduation criterion:** the dev-agent-live numbers above for the Echo
  flip; one clean week of enforcing on Echo for the fleet decision.
- **dark-window:** the fleet stays `off` until that decision. A dark feature
  guards nothing: this spec claims the floor only where `mode` reads
  `enforcing`. The dev-agent-live review, the Echo flip and the fleet
  decision are one tracked action, owned by Echo, reviewed first on the day
  after this release reaches Echo; where that action's own text differs from
  this section, this section governs. (recorded on ACT-074)

**Mixed versions.** Senders sign whatever the receiver's version, and a
receiver only refuses when someone has set `dryRun: false`, so agents update
in any order. Against an ENFORCING receiver, a sender on an older release
does not sign: its relay-send messages take the relay; its `MessageRouter`
sends get the 401, which the old sender treats as an outage and parks in the
drop directory, where the enforcing receiver holds it (not ingested, not
deleted) for 7 days. That sender's store says `queued` throughout. The
dev-agent-live `unsigned` count is the check for this before any flip.

## Rollback

`threadline.localRouteSignature.dryRun: true` (or removing the key) stops
refusing at the next request; `enabled: false` stops verifying. No durable
state to repair: the check writes only its audit log, and a held drop is
ingested at the next boot once the mode is no longer enforcing. Reverting the release removes the sender signing too, which an
enforcing receiver on a newer release would then refuse as `unsigned` —
set receivers back to dry-run first.

## Migration parity

- **Config:** no default is written (`enabled` must stay omitted for the
  gate to decide). The block is added to the config type.
- **CLAUDE.md:** one section "A2A local-route signed envelope" in the
  template and in `migrateClaudeMd` (sniff key `A2A local-route signed
  envelope`), listed among the framework-shadowed sections.
- **Drops written before this release** carry no signature. They are
  ingested as today in `off` and `dry-run`; an enforcing receiver holds
  them and expires them at 7 days (counted).

## Agent awareness

| Section | Content |
|---|---|
| A2A local-route signed envelope | Messages I send to another agent on this machine carry a signature made with my identity key. With `threadline.localRouteSignature` on, my same-machine route checks each incoming message's signature against the key I have on record for the sender's name. It starts watch-only (`dryRun`, the default): everything is delivered as before and each message that would be refused is logged (`[relay-agent-signature] would-refuse`) and counted by reason. With `dryRun: false` such a message is refused before it is recorded, with HTTP 401 `{ error: 'bad-signature', refused: true, reason, remedy, retryable }`; a relay-send then falls back to the relay. If I have no key on record for the sender I fetch it myself on first contact, into memory (at most five tries per peer). `signature-invalid` from a peer I know means it signs with a different key than the one I hold; I never swap a key on my own — find out why its identity moved first, and know that `threadline_discover` re-reads EVERY peer's key, not just that one. A message another agent parked for me while I was down is held, not ingested, if I cannot prove it, and expires after 7 days (`dropsHeld`, `dropsExpired`). Live on a development agent, off on the fleet. Mode and counters: authed `/health` → `threadline.localRouteSignature`. A sender that must never deliver an unproven message adds the header `X-Instar-Require-Signature: v1`; unless I am enforcing I refuse that request with reason `not-enforcing`. **When to use** (PROACTIVE): before turning `dryRun` off, read the last 24 hours of `logs/relay-agent-signature.jsonl` (one row per check), not the `/health` counters, which reset at every restart: at least 20 `verified` rows per peer, and no `unsigned`, `signature-invalid` or `fingerprint-mismatch` row. If the file's oldest row is newer than 24 hours, or `auditWriteFailures` is not zero, the answer is unknown and the flip waits. If `signerAvailable` is false, an enforcing peer refuses everything I send it locally. |

## Tests

- **Unit** (`tests/unit/a2a-local-route-signed-envelope.test.ts`): the signed
  bytes (key order, `undefined`, a `Date` member, both bounds); sign then
  verify with a real key pair; every reason against a real registry file and
  an injected clock, both sides of each boundary (fresh/stale past and
  future, right/wrong recipient, one key/two keys/key under two names, full
  vs prefix fingerprint, empty nonce, tampered body / nonce / relay chain /
  `to`); the proven fingerprint derives from the key, not the stored field;
  the replay cache, its per-sender and overall bounds;
  mode resolution (omitted on a dev agent and on a fleet agent, explicit
  values, `dryRun` only left by `false`); the first-contact probe against a
  stub health server (fetches and verifies; writes no file; refuses an
  answer naming another agent or a disagreeing fingerprint; a forged
  envelope under a cached name is `signature-invalid` and the next genuine
  one still verifies; never replaces a
  held key on a signature failure; single-flight; doubling backoff;
  five-probe close and its one report; no slot for a name with no running
  entry; two names answering with one key, which counts as a failed
  probe); the fixed test vector; the
  production signer factory signs with the Threadline identity and its
  output verifies against that identity's public key; with no identity and
  with a foreign `from` it does not sign; the rate-limited, bounded log line; `MessageRouter` with a stub
  fetch and a redirected home directory (accepted / refused at 401, 403 and
  503 / unreachable; signed before a drop when the target is not
  registered; an answered 500 without the flag drops as today); drop pickup
  in each mode (existing deletes unchanged; ingest; held; the boot pass
  never probes or expires; the second pass probes, expires at 7 days and
  reports once when anything is held or expired; a verifier error holds);
  the audit log (one metadata-only row per verdict, none when off, never
  message text, mode 0600 after a forced rotation, a failed append
  counted); the per-request requirement header in each mode; migration
  parity.
- **Integration** (`tests/integration/threadline/a2a-local-route-signed-envelope.test.ts`):
  the real route on a real `AgentServer` with a real ledger and registry, in
  each mode: `off` ignores the field; dry-run delivers an unsigned envelope,
  counts `wouldRefuse` / `byReason.unsigned` and answers `signature.verified:
  false`; enforcing refuses each reason with its 401 body and leaves no
  inbox entry, no ledger row and no content window, with auth still first; a
  signed envelope is delivered, answers `signature: { mode: "enforcing",
  verified: true }` and the ledger key carries the proven fingerprint; a
  request with the requirement header is refused `not-enforcing` in `off`
  and dry-run (no inbox entry) and handled normally when enforcing; a
  real `MessageRouter` with the production signer delivers to a second real
  server and on a refusal fails without writing the drop directory; the
  health block and the advertisement.
- **E2E** (`tests/e2e/threadline/a2a-local-route-signed-envelope-alive.test.ts`):
  two real servers booted the production way: `/threadline/health` reports
  the mode; the sender's real relay-send name path delivers locally to an
  enforcing receiver and `verified` counts one; `POST /messages/send` on
  the sender (the production `MessageRouter` signer) delivers to the same
  receiver; a hand-rolled unsigned POST is refused; a receiver with no key on record for the sender probes the
  sender's live health and delivers, and its `known-agents.json` is
  unchanged.
- Existing tests that post to the route run with the feature off and are
  not changed.

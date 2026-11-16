---
title: Threadline HTTP peer trust — a handshake is not a grant, and a pairing keeps its key
slug: threadline-http-peer-trust
date: 2026-11-15
author: echo
parent-spec: a2a-relay-unknown-sender-trust.md
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "The direct HTTP peer handshake proves that a sender holds a key; it does not prove who the sender is, and nobody granted that key anything. This change makes the direct HTTP path ask the same trust manager the relay path asks before a message can reach a session, and stops a pairing name from being re-bound to a different key."
binding-standards: ["Know Your Principal — An Unverified Identity Is a Guess", "A Refusal Stays a Refusal — conservation of negative outcomes", "A Dark Feature Guards Nothing", "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"]
eli16-overview: threadline-http-peer-trust.eli16.md
security: true
approved: true
approved-by: "operator standing authorization for the Instar security program (telegram 141385, 2026-11-15 13:19 — \"a constant effort for scanning Instar … fixes through /instar-dev\") + the explicit rollout decision for this change (telegram 141385, 2026-11-15 14:16, \"Yes, live\"). Merge remains gated on a GitHub code-owner review."
review-convergence: "2026-11-15T22:43:37.348Z"
review-iterations: 6
review-completed-at: "2026-11-15T22:43:37.348Z"
review-report: "docs/specs/reports/threadline-http-peer-trust-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 3
---

# Spec — Threadline HTTP peer trust

Source: Instar security program (operator, topic 141385, 2026-11-15). Found by the
program's first threat-map pass and reproduced with failing unit tests and on a
throwaway agent before this fix was written. Details of the reproduction are kept
out of this public document until the fix is installed.

## Terms

- **Direct HTTP peer path**: the Threadline peer-protocol routes another agent
  reaches over this agent's public URL: `POST /threadline/handshake/hello`,
  `POST /threadline/handshake/confirm`, then the signed
  `POST /threadline/messages/receive`. These are exempt from the bearer token by
  exact route (`isThreadlinePublicRoute`), because a peer never holds it.
- **Relay path**: messages that arrive over the Threadline relay. Its unknown-sender
  handling is `a2a-relay-unknown-sender-trust.md`.
- **Trust manager**: `AgentTrustManager`, the single authority for a fingerprint's
  level and the operations that level allows.

## Problem (class)

The direct HTTP handshake is open by design: any caller can complete it with a key
it made. Two consequences were not intended:

1. **A pairing name could be re-bound to a different key.** The confirm step stored
   the new key under the name without comparing it to the key already pinned for
   that name.
2. **A new pairing was treated as a grant.** A message from any freshly paired key
   went to the router with no trust check, no trust level and no relay context, so
   it could start a session. The relay path has asked the trust manager since
   `a2a-relay-unknown-sender-trust`; this path never did.

No Instar code initiates the direct HTTP handshake (the relay and verified pairing
are the supported ways for agents to talk), so the path's legitimate users are
outside or hand-written clients, and on agents checked so far there are none.

## Design

### 0. The direct peer protocol is closed unless the owner opens it

No Instar code uses the direct HTTP peer protocol: `initiateHandshake` has no caller
in `src/`, `MessageRouter` uses `/messages/relay-agent` and `/messages/relay-machine`, and `AgentBus.httpSend` posts
to a different, unsigned path. Agents reach each other over the Threadline relay. So
the first and largest part of this fix removes the attack surface instead of guarding
it: `POST /threadline/handshake/hello`, `POST /threadline/handshake/confirm`,
`POST /threadline/messages/receive`, `POST /threadline/threads/backfill` and
`GET /threadline/blobs/:id` answer `404 TL_NOT_FOUND` ("This agent does not accept
direct peer connections. Reach it through the Threadline relay.") before any
processing, unless `threadline.directPeerProtocol.enabled` is `true` (read live).

- The guard is one router middleware, matched on the lower-cased path with trailing
  slashes removed (Express routing is case-insensitive and slash-tolerant).
- `createThreadlineRoutes` treats an absent switch as closed, and a switch that
  throws as closed.
- `GET /threadline/health` is unchanged and stays public.
- The routes stay on `isThreadlinePublicRoute`: when the owner opens the protocol,
  peers still need to reach them without the bearer token.

Everything below (§1 to §3) applies when the owner has opened the protocol. It is
defence in depth: a protocol someone opens deliberately should still not let a
stranger in. The code is kept rather than deleted because an owner can open the
route with one live setting, and the unit, integration and e2e tests exercise it on
every run, so it is not unexercised code.

### 1. A grant comes before the handshake, and a pairing keeps its key

**Grant before handshake.** `POST /threadline/handshake/hello` runs the same admission
as receive (§2) on the key the caller presents, before `HandshakeManager` sees it. A
key with no decided grant is refused `403 TL_SENDER_NOT_TRUSTED` and leaves nothing
behind: no handshake state, no rate-limit entry, no pinned name. Only keys the owner
(or a verified pairing) already granted can pair. This is the authorized-keys pattern
(the owner provisions keys in advance) rather than trust on first use, raised by the
round-4 clean-door review, and it removes the stranger cases below at the root: a
stranger with no granted key cannot squat a name or lock one out. (A holder of a
granted *public* key — which is not secret — can still delay that key's own pairing,
by starting hellos under fresh names or using up its per-minute attempts, for as long
as it keeps going; it can never produce a pairing, since confirm needs the private
key. A signed hello would remove even that, and is out of scope for a route no Instar
code uses.) With `httpPeerTrust.enabled: false` the handshake is open as before.

**The hello is unsigned, so the check is on a key the caller need not hold.** Public
keys are not secret: anyone can present a granted peer's key. That cannot complete a
pairing (confirm needs the private key), but it could grow state, so pending state is
bounded by the number of granted keys rather than by names:

- attempts are counted per presented key, not per name;
- each hello drops expired handshakes and keeps at most one pending handshake per
  presented key;
- a confirm that fails verification proves nothing about its sender, so it neither
  ends a pending handshake nor counts as a failure; an expired one is dropped
  uncounted.

A signed hello (proof of possession before any state) would remove even this; it is
a wire-protocol change for a protocol no Instar code uses, and is not needed for the
bound above.

The rest of this section applies between keys that are granted.

`HandshakeManager.keyConflict(name, key)` is true when the name is already paired
and the pinned key differs. Then the step is refused. It is checked at all three
steps that can write a pairing: `handleHello` (responder, earliest),
`handleConfirm` (responder, at the write, since another pairing may land between
hello and confirm) and `handleHelloResponse` (initiator). Re-pairing with the SAME
key still works.

- **One refusal text** (`Handshake refused`) for the refusals this spec adds (key
  change, unusable name), so the refusal does not say why. Other handshake errors
  (rate limit, timeout, bad signature) keep their existing texts. (A caller can still tell a paired name from a free one
  by whether its hello succeeds; this does not promise that names cannot be listed.)
- **Not counted against the name.** A key conflict is checked before the per-name
  attempt counter and is never recorded as a failure, and neither is a confirm that
  arrives with no handshake in progress. Otherwise anyone could block a real peer's
  name without holding any key. Residual, accepted while the protocol is opened: a
  hello carrying the pinned *public* key still counts toward the per-minute attempt
  limit and can replace a pending handshake, because the hello is unsigned. It delays
  a re-pairing by up to a minute at a time; it grants nothing, and the hour-long
  failure block cannot be triggered this way.
- **An unreadable pairing store fails closed.** If `relay-tokens.json` exists but
  cannot be parsed, or is not a JSON object, no new pairing is accepted for any name and the file is left as
  it is, instead of treating every pinned name as free. The way out is agent work, not
  owner work: on the owner's request the agent backs the file up, removes or repairs
  it, and restarts. The owner route cannot repair it, since the store's contents are
  unknown.
- **A stored entry with no key still holds its name.** A pairing entry whose key is
  missing is treated as taken, not free: only the owner frees a name.
- **Failed confirms under a paired name are not counted.** A timeout, an incomplete
  state or a bad signature on confirm counts toward the per-name block only for a
  name that is not yet paired, because the pinned public key lets anyone start a
  hello under a paired name.
- **Unusable names.** A hello whose name is shaped like a fingerprint (16+ hex
  characters), equals this agent's own name, is an object-prototype key
  (`__proto__`, `constructor`, `prototype`), has surrounding whitespace, or is not in
  Unicode NFC is refused (`isUsablePeerName`), so one name has one spelling.
- **The pin is by first use of a name, not proof of identity.** Whoever pairs a name
  first holds it on this path. That is availability only: admission (§2) is by
  fingerprint, so holding a name grants nothing. The owner frees a name with
  `DELETE /threadline/pairings/:agent` (bearer token; not on the public allowlist),
  for example after a peer reinstalled or when a stranger took a peer's name first.
  Pairings are per machine, so this frees the name on the machine that served it.

### 2. A handshake is not a grant (ThreadlineEndpoints receive)

Before the inbound-id ledger, the ack, the thread record, the homebase post or any
routing, the receive handler calls `decideHttpPeerAdmission`
(`src/threadline/httpPeerTrust.ts`):

| Condition | Result |
|---|---|
| switch explicitly off (`threadline.httpPeerTrust.enabled: false`) | admit (the previous behaviour) |
| no signature-derived fingerprint | refuse `no-verified-principal` |
| trust source returns a verdict that allows the operation | admit `trusted`, level passed on |
| trust source returns a verdict that does not | refuse `not-trusted` |
| no trust source, or it throws | refuse `no-trust-source` |

**The verdict** comes from `resolveHttpPeerTrust(trustManager, fingerprint,
operation)`, which calls `resolveRelayUnknownSenderTrust`, the relay path's own
resolver, so the trust manager stays the only authority for level → operations.
It differs in two ways. First, **only a decided trust source counts**
(`user-granted`, `paired-machine-granted`, `mutual-verified`: an allowlist, so a
source added later is not a grant until it is listed); a profile the system created
by itself (`setup-default`, which recording a stranger's relay message writes) is
not. Second, an ack needs the message level (below). Without this, one relay message from a
stranger's key would have minted a profile that admits the same key here (the HTTP
and relay fingerprints are the same `computeFingerprint`).

**The operation** comes from `classifyHttpPeerOperation(message)`, never from the
sender's `type` label. There are only two: `ack` exactly when the body is one the ack
stage will consume (`parseKindedAck` / `isAutoAckBody`, which also stop it before the
thread record, the homebase post and the router), and `message` for everything else,
because everything else goes on to the router whatever its label says. Both are asked
of the trust manager as a message (`resolveHttpPeerTrust` always asks `chat`). **On this path an ack needs the same level as a
message.** The relay lets every level send an ack because there it only records that
our own earlier send arrived. Here an ack names any thread id and updates delivery
and liveness records for that thread, so a sender with no grant may not send one.

A pairing made over this handshake grants nothing, whether it was made before or
after this check shipped: an older TOFU pairing is no more evidence of who the
sender is than a new one.

A refusal answers `403 TL_SENDER_NOT_TRUSTED` with one fixed text and writes
nothing. It is logged at most once per refusal reason per minute and counted in
`httpPeerTrustCounters`, served on the authed `GET /health` detail as
`threadline.httpPeerTrust` (with `trustManagerWired`). An admitted message passes
`localTrustLevel` so the live-inject grounding states the real level instead of the
`verified` default.

**Backfill** (`POST /threadline/threads/backfill`) is not behind admission: it serves
only threads the sender's own fingerprint already took part in, so a stranger gets
nothing from it. `GET /threadline/blobs/:id` always answers 404.

### 3. The sender is recorded by its fingerprint

The body's `from.agent` is only a claim, and the header name is bound to a key only
by first use (§1); one key can pair several names. So after admission `from.agent`
is overwritten with the **signature-derived fingerprint**, exactly what the relay
path records, and the header name is kept as `from.name`. Thread ownership and the
anti-hijack comparison key on the principal admission checked, and `recordInboundAck`
is given the fingerprint instead of the name. (The shared ack bookkeeping itself does
not compare the sender with the thread's recipient; that is SEC-031, below.)

**Where the fingerprint comes from.** `threadlineAuth` verifies the request's Ed25519
signature against the identity key pinned for the header name at pairing, and the
fingerprint is `computeFingerprint` of that pinned key. Nothing in the body or headers
other than the signature contributes to it. A name carries
no authority on this path. Display: the homebase post labels the sender with
`from.name` (a display label, never a key); the session prompt and grounding show the
fingerprint, as they do for a relay sender without a known name. That is the accepted
cost of keying by principal on an opt-in path with no current users.

### Configuration

Both read live (`LiveConfig.get` re-checks the file on every call):

- `threadline.directPeerProtocol.enabled`: absent means CLOSED (§0). Only `true` opens it.
- `threadline.httpPeerTrust.enabled`: absent means ON (§2). Only an explicit `false`
  turns the admission check off, and it matters only while the protocol is open.

### Wiring

`src/server/routes.ts` passes `httpPeerTrust` to `createThreadlineRoutes`:
`resolve` reads `ctx.unifiedTrust?.trustManager`; `enabled` reads the live config.
`ctx.unifiedTrust` exists only where the trust manager does: on the machine holding
the relay. On a machine with the relay off or in standby there is no trust source,
and every sender on this path is refused.

## Remaining exposure outside this spec

This spec closes the direct HTTP path. Two weaknesses in the shared trust layer it
reads are separate fixes in the same security program, named here so the claim is
not overstated:

- On fleet agents the relay path's own unknown-sender check
  (`a2a-relay-unknown-sender-trust`) is still observing, not enforcing, so a
  stranger on the relay can still reach a session there. Tracked as SEC-019 in the
  security program ledger. <!-- tracked: SEC-019 security program ledger -->
- The `threadline_trust` grant tool accepts any local caller as the owner
  (`ThreadlineMCPServer`, `isLocal`), so a session could be talked into granting a
  level. That is the grant this spec's admission relies on. Tracked as SEC-018.
  <!-- tracked: SEC-018 security program ledger -->
- Both switches above are live config a session can edit with its bearer token, so a
  session talked into it could reopen the protocol. The same class as SEC-018 (a
  session acting as the owner); tracked there. <!-- tracked: SEC-018 security program ledger -->
- Backfill serves a sender its own past threads even after its grant is revoked,
  while the protocol is open. Accepted: it returns only what that sender already
  took part in.
- With the protocol open, a *granted* sender's ack is not checked against who our
  original send went to, the same as on the relay path today. Accepted here: it needs
  a decided grant, the protocol is opt-in, and the fix belongs to the shared ack stage
  (both paths); recorded in the security program ledger as SEC-031.
  <!-- tracked: SEC-031 security program ledger -->

## Decision points touched

| Decision point | Classification | Basis / floor |
|---|---|---|
| Direct peer protocol open or closed | invariant; basis: enumerable-domain; evidence: the five routes are an exact list, no Instar caller uses any of them, and the answer is a fixed 404 | Deterministic: the owner's switch decides; absent or unreadable is closed. |
| Handshake key pin: refuse a different key for an already-paired name | invariant; basis: irreversible-consequence; evidence: replacing a pinned key hands the name's relay token and threads to whoever holds the new key, and the previous key-holder cannot reclaim it in-band | Deterministic by design: the handshake carries no other evidence of who the caller is. Recovery is an owner action (`DELETE /threadline/pairings/:agent`). |
| Unusable peer names (fingerprint-shaped, this agent's own name, prototype keys) | invariant; basis: enumerable-domain; evidence: the collision classes are exactly the values a name is compared against or stored beside: a fingerprint, the local agent's name, and the keys of the plain object that holds pairings | Deterministic. |
| Grant checked at the handshake (hello) | invariant; basis: irreversible-consequence; evidence: a hello from an ungranted key is the only way a stranger creates server state (handshake entry, rate-limit entry, pinned name), and every later step depends on a grant anyway | Deterministic: the same admission as receive, before any state. |
| HTTP receive admission (admit / refuse before routing) | judgment-candidate | Floor: two actions (admit, or refuse-with-403); conservative default refuse when no principal, no trust source, or a throwing source; arbiter = the trust manager via `resolveRelayUnknownSenderTrust`, the relay path's arbiter. The only local rules are which profiles count (decided, not system-written) and which operation a body is (what the ack stage will consume). |
| Unreadable pairing store refuses every new pairing | invariant; basis: irreversible-consequence; evidence: treating an unreadable store as empty would let any key take any pinned name, and the overwrite would erase the pins for good | Deterministic; the owner fixes the file on the host. |
| Failed confirms counted only for unpaired names | invariant; basis: irreversible-consequence; evidence: for a paired name the pinned key is public, so counted failures would let anyone impose the hour-long block on the real peer | Deterministic. |
| Body `from.agent` replaced by the verified fingerprint (applies whether or not the admission switch is on) | invariant; basis: irreversible-consequence; evidence: the body field is sender-written text and the header name is first-come, so routing or thread ownership keyed on either lets one principal act inside another's conversation | Deterministic: the fingerprint is the principal admission checked. |
| Fixed limit: one refusal log line per reason per minute | invariant; basis: external-constraint; evidence: a refusal is unauthenticated traffic, so an unthrottled line per request lets any caller fill the server log | Deterministic. |
| Fixed limit: handshake attempt limit (5 per minute) counted per presented key, not per name | invariant; basis: external-constraint; evidence: the hello is unsigned and public keys are not secret, so a per-name counter would grow without bound under fresh names | Deterministic; the hello route rejects any key not exactly 64 hex before admission, so a key cannot be respelled into extra entries. |

## Frontloaded Decisions

0. **Close the unused route instead of only guarding it.** Raised by the clean-door
   review in round 2: with no legitimate users, removing the attack surface is
   simpler and stronger than patching a TOFU handshake, which kept producing new
   edge cases (lockout, one key many names, store corruption). The guard stays for
   owners who open the protocol.
1. **Rollout: live for every agent in the next release, with the off switches.**
   This leaves the usual dark → Echo → fleet ladder, which only the operator may
   waive (*Maturation Path*'s only written exit is *User-Facing Fixes Ship Live*).
   **Operator decision:** "Yes, live" [source: telegram 141385, 2026-11-15 14:16 PST],
   replying to the Chief of Staff's 14:11 ask ("Reply yes, ship it live to send it to
   every agent at once, or no, go Echo first", recommending live with an off
   switch). Basis put to him: the gap is critical, no Instar code uses the route,
   the owner sees nothing, and nothing that works today stops working.
2. **No owner-facing notice** for refused senders, but counters on the authed
   health detail so a refused real peer is detectable. Surfacing strangers to the
   owner would add attention cost for traffic that is almost always unwanted
   (*Remove What Demands Attention*), and the refused sender is told how to pair.
3. **A key change under a paired name is refused in-band**; the owner can remove the
   pairing (`DELETE /threadline/pairings/:agent`). No automatic expiry: a pin that
   expires on its own reopens the replacement it exists to stop.
4. **No grandfathering of existing direct-HTTP pairings.** An earlier draft admitted
   pairings present at upgrade. The Standards-Conformance Gate flagged it (Know
   Your Principal; Cross-Store Coherence): those pairings were TOFU too, so admitting
   them preserves the gap for anyone who already paired, and it was a second
   admission authority beside the trust manager. Dropped.
5. **No trust source (relay off, or standby) refuses every sender on this path.**
6. **System-written (`setup-default`) profiles are not grants on this path**, even
   though the relay resolver counts them. Changing that for the relay path itself
   belongs to SEC-019.

## Open questions

*(none)*

## User-visible effect

None for the owner: no notice, no new step, no change to the dashboard or any
channel. Peers on the relay or paired by invite are unaffected (different path).
Anything that calls the direct peer routes gets a 404 telling it to use the relay;
no Instar code does. With the protocol opened by the owner, senders whose key holds
no decided grant are refused with a clear message. That loss falls only on such
senders, and it is the vulnerability itself (critical, which *Security Fixes Keep the Experience
Whole*, operator-approved 2026-11-15 and landing in PR #3200, allows). No Instar code
sends on this path (`initiateHandshake` has no caller in `src/`), and Echo, the one
agent inspected, has never had a pairing on it.

## Multi-machine posture

This spec adds no replicated state. Both stores it reads are already machine-local:

- The admission check reads this machine's trust manager. `threadline/trust-profiles.json`
  is registered machine-local (`src/data/state-coherence-registry.json`), and the
  trust manager exists only on the machine holding the relay. So a grant made on
  the relay holder applies there; a standby refuses every sender on this path.
  machine-local-justification: physical-credential-locality — the trust manager is built only where the relay connection (a per-machine authenticated session) lives, and its profiles are not replicated today; this spec does not change that.
- The key pin reads the per-machine pairing store (`threadline/relay-tokens.json`).
  machine-local-justification: physical-credential-locality — each entry is a relay token derived from that machine's own ephemeral handshake keys and is valid only against the machine that minted it; copying it to another machine would replicate a session secret.

The refusal counters are per process, like the relay sibling's.

## Maturation plan

- **test-agent-live:** the E2E test (`tests/e2e/threadline-http-peer-trust-alive.test.ts`) on the real `AgentServer`, plus the throwaway-agent proof kept in the security program's private records: default config closes every direct route (404), and with the protocol opened a stranger is refused with no session.
- **dev-agent-live:** live on the development agent from the release that carries it. For one week, watch the authed `/health` → `threadline.httpPeerTrust` counters and the server log for `HTTP receive refused` / the direct-route 404s.
- **fleet:** the same release, ungated (Frontloaded Decision 1; operator "Yes, live", telegram 141385, 2026-11-15 14:16 PST). No dark window.
- **graduation criterion:** over the first week after release, across the fleet, no legitimate peer is refused: the `httpPeerTrust` admitted/refused counters show no refusal of a peer the owner expected to reach the agent directly (expected to be zero events, since no agent uses the direct route), and no report of a broken peer connection traced to this change. A refusal of a real peer is a regression to investigate, not a pass.
- **dark-window:** none — the fix is live on release. The admission check and the direct-route open switch exist for an owner who deliberately opens the route; they are off by default, which is the shipped state, not a dark feature (the routes they guard are closed).
- **ladder:** not applicable: ships enabled for every agent in one release with off switches (operator decision cited above)
- Rollout order within that release: test-agent-live to dev-agent-live to fleet (same release, ungated).

The whole ladder ships in one release because no agent uses the direct route; the admission half behind the owner's switch rides the same release.

## Rollback

Set `threadline.directPeerProtocol.enabled: true` and
`threadline.httpPeerTrust.enabled: false` (live, no restart) to restore the previous
admission behaviour of the routes, or revert the PR. The key pin, the name rules, the
fingerprint attribution (§3) and the delivery-record change have no switch: reverting
the PR restores them. Threads a direct sender opened before the upgrade were keyed by
name; after it they no longer match the fingerprint, so such a sender starts a fresh
thread (no direct pairings exist on the agents inspected). No data migration.

## Tests

- Closed by default: every direct route (including case and trailing-slash
  variants) answers 404 with nothing paired or routed, health still answers, a
  throwing switch stays closed; through the real server, a default config is closed.
- Grant before handshake: a stranger's hello is refused with no handshake state,
  rate-limit entry or pairing; a flood of fresh names with ungranted keys leaves no
  state; a granted PUBLIC key presented without its private key under many fresh
  names leaves at most one pending handshake and one rate entry; a garbage confirm
  does not end a granted peer's handshake; a granted key pairs; a revoked key is
  refused at receive.
- `tests/unit/threadline/threadline-http-peer-trust.test.ts`: key pin on hello,
  confirm (race) and initiator paths; same-key re-pair; wrong-key floods do not lock
  out the real peer; fingerprint-shaped and own names refused; owner removal frees a
  name; stranger refused with nothing routed; an `ack` label with a chat body
  refused; a `setup-default` profile is not a grant; no trust source refuses; real
  `AgentTrustManager` untrusted → refused and granted → admitted with level; a
  pairing that existed before the check still needs a grant; even a real ack body
  needs a grant; an unreadable pairing store refuses; unsolicited confirms do not
  lock a name; the off switch; the sender recorded by fingerprint with the name as
  display; the decision table including throwing sources.
- Reproduction re-run: the throwaway-agent proof that showed the gap is re-run
  against the fixed build (evidence in the PR).
- `tests/integration/threadline/http-peer-trust-wiring.test.ts`: through the real
  `AgentServer` (auth middleware + routes.ts), a stranger is refused with no trust
  manager, and a granted fingerprint is admitted.
- Existing receive tests (`ThreadlineEndpoints.test.ts`,
  `inbound-id-ledger.test.ts`, `ack-never-acked.test.ts`) give their trusted
  sender a granting trust source; their assertions are unchanged.

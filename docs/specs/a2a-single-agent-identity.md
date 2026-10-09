---
title: "A2A single agent identity — one identity across all machines, loudly checked, honestly reported"
slug: "a2a-single-agent-identity"
author: "echo"
status: "draft"
origin: "CMT-706 (Justin, Telegram topic 9210, 2026-10-09): 'Find a robust solution so agent identity mismatches are NEVER an issue for agent-to-agent communication.' Incident 2026-10-08 / ACT-058."
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "Verify the State, Not Its Symbol; No Silent Degradation; The Agent Is Always Reachable; Know Your Principal — An Unverified Identity Is a Guess; Structure > Willpower; Close the Loop; Self-Heal Before Notify; Bounded Notification Surface"
parent-spec: "docs/specs/agent-identity-continuity-on-expansion.md"
related-specs: "docs/specs/machine-coherence-guard.md; docs/specs/a2a-cross-machine-route.md; docs/specs/cross-machine-secret-sync-spec.md; docs/specs/threadline-identity-single-writer.md; docs/specs/machine-self-assertion.md"
eli16-overview: "docs/specs/a2a-single-agent-identity.eli16.md"
review-convergence: "pending"
approved: false
---

# A2A single agent identity

One agent, one identity, on every machine — and when that is not true, the agent says so
before a peer has to.

This spec is deliberately five parts and no more (operator direction, 2026-10-09: 80/20
convergence, no over-engineering). Everything a reviewer wanted beyond them is in
§Out of scope with a carrier.

## Problem

### The incident (2026-10-08)

Echo runs on four machines. Three of them (the Mini, the Laptop, the Mama PC) publish
routing fingerprint `63b1dbb2…`, the value every peer has pinned for Echo since May. The Mac
Studio had minted its own canonical identity (`.instar/identity.json`, created 2026-08-26,
routing fingerprint `afd256bc…`). The Studio also held the serving lease and therefore the
one relay connection the agent is allowed. So for every day of that overlap:

- peers addressed `63b1dbb2…`, which no machine had connected to the relay as;
- the relay answered them `queued` (it queues for any fingerprint that is not connected right
  now, holds the message 24 h), then silently expired each one;
- the Studio sat connected as `afd256bc…`, an address nobody had pinned, and received nothing.

Dawn's messages from 2026-10-05 onward were lost. Nothing on Echo's side reported it, and
nothing on Dawn's side could tell "offline for a while" from "no one will ever receive this".
It was fixed by hand on 2026-10-09 (the Mini's `.instar/identity.json` copied onto the
Studio, server restarted). This is the SECOND split of the same machine: the parent spec
(`agent-identity-continuity-on-expansion.md`, approved 2026-08-19) shipped a join-time carry
on 2026-08-19/20, and the Studio minted `afd256bc…` on 2026-08-26, six days after.

### Why the parent spec did not prevent it (confirmed in code at `e76caca6a`, v1.3.1334)

1. **The guard protects the wrong mint site.** The parent's mint guard lives in the Threadline
   client's `getOrCreate()` (`src/threadline/client/IdentityManager.ts:88-118`). But the
   server boots the trust system FIRST, and `createUnifiedTrustSystem`
   (`src/threadline/UnifiedTrustWiring.ts:86-105`) calls `CanonicalIdentityManager.create()`
   whenever `.instar/identity.json` is absent — with no join check. The canonical file then
   exists and the guarded site never fires.
2. **There is no path to obtain the identity after pairing.** `installAgentIdentityFromPairing`
   (`src/core/AgentIdentityHandover.ts:273`) runs only inside `instar join`. A paired machine
   that has lost (or never received) its identity has no way to ask a sibling. The parent's
   reconciler `decideReconciliation` (`src/core/AgentIdentityReconciler.ts:60`) has no callers.
3. **The split detector compares two different fingerprint formulas, so it can never report
   agreement.** The boot detector (`AgentServer.ts:2909-2990`) computes `fingerprintOf` =
   `sha256(pub).slice(0,32)` (`AgentIdentityHandover.ts:198`) and compares it with each peer's
   `/provenance` value, which is the raw public-key prefix (`provenance.ts:71`) — the formula
   the relay, `/threadline/health` and every pinned peer use (`computeFingerprint`,
   `MessageEncryptor.ts:80-82`). Today, with all four machines REPAIRED, the server log says
   `[identity-divergence] SPLIT: 63b1dbb2… vs ff2e6980…`. A detector that fires identically on
   healthy and broken fleets is ignored, which is exactly what happened. It also runs once,
   90 s after boot.
4. **The relay's `queued` is indistinguishable from "nobody will ever receive this".** The
   relay queues for any fingerprint not connected right now and tells the sender only a TTL.
   The sender's ledger (`A2ADeliveryTracker`) marks a peer `stale` after 6 h, but that is a
   read-only field. The one component that could speak — `A2ARedeliverySentinel` (escalate
   once per peer, one aggregated item) — ships `enabled: false`.
5. **A reply from a machine that does not hold the lease is held forever, silently** (ACT-058,
   topic 122413, 2026-10-08). With the session pool on, a topic is legitimately owned by a
   standby. Its replies go through `TelegramOriginService`, whose `authorize` requires
   `holdsLease()` (`TelegramOriginBoot.ts:139`). The hold keeps the payload in a per-process
   map, never calls the store's existing `recordOperationState('held')`, is excluded from the
   outage notice, and is retried every 15 min by a non-lease-gated recovery tick — so the
   standby re-holds its own message nine times and drops it. The forward-to-holder primitive
   (`telegram.outboundRelay` → `relayOriginBot`) exists, but `TelegramAdapter.sendToTopic`
   (`:1392`, mirrored by `willRelay()` at `:663`) takes it only when the adapter has NO bot
   token.
6. **The Files tab hands out private keys.** `GET /api/files/download` (`fileRoutes.ts:859-907`)
   streams any project file that passes the code-owned `NEVER_SERVED_PREFIXES` and the
   config-editable `blockedFilenames`. Neither covers `.instar/identity.json` (the canonical
   Ed25519 private key, plaintext), `.instar/threadline/identity.json`, `.instar/machine-ssh/*`,
   `.instar/state/inbound-delivery.hmac-key`, `.instar/relay-tokens.json` or
   `.instar/local-state/keys.enc`. The basename check runs on the REQUESTED name, so a symlink
   defeats `*.key`. Any Bearer holder can download the agent's signing identity.

Every item is the same defect at a different layer: a symbol was trusted in place of the
state it stands for (one mint site; one formula; "queued" read as "will arrive"; `admitted`
read as "will be sent"; "allowed path" read as "safe to serve"). The parent spec's own
acceptance criteria AC1/AC6/AC7/AC7b are unmet in code; §Tests binds every criterion of THIS
spec to a named test.

## What exists (verified at `e76caca6a`)

- **Canonical identity**: `CanonicalIdentityManager` (`src/identity/IdentityManager.ts`),
  file `.instar/identity.json` `{publicKey, privateKey, canonicalId, displayFingerprint, …}`,
  written through the single owner-only writer `src/identity/IdentityKeyFile.ts`.
  `canonicalId`/`displayFingerprint` are trust-system ids, not the routing address.
- **Routing identity**: `IdentityManager` (`src/threadline/client/IdentityManager.ts`) reads
  canonical first, legacy `.instar/threadline/identity.json` second, reports `filesDisagree`,
  uses canonical; `get()` is cached after first load. Routing fingerprint =
  `computeFingerprint(pub)` = first 16 bytes of the raw public key as hex — what the relay
  registers (`ThreadlineBootstrap.ts:433`), `/threadline/health` and `/provenance` publish,
  and peers pin. The listener daemon (`listener-daemon.ts:135`) loads the LEGACY path as its
  primary key file.
- **Join-time carry** (parent §1, built): `POST /api/pair` seals the identity to the joiner's
  ephemeral X25519 key with `encryptForSync`; `installAgentIdentityFromPairing` writes
  atomically and never mints on failure. Envelope `identityFingerprint` is in the sha256 form.
- **Mint guard** (parent §2, built at ONE of two sites): `getOrCreate()` throws when
  `detectJoinedMesh()` sees any registry row (status ignored — the safe direction).
- **Cross-machine secret sync**: `SecretSync.ts`, X25519+HKDF+AES-256-GCM per recipient
  (`SecretStore.encryptForSync/decryptFromSync`) sealed to the recipient's REGISTRY
  `encryptionPublicKey`; transport `POST /mesh/rpc` (requests Ed25519-signed by the sending
  machine, nonce replay check, sender must be a registered active peer; RESPONSES are not
  signed; LAN ropes are plain HTTP). `AccountCredentialShare.ts` establishes that
  credential-class payloads get their OWN verb.
- **Machine registry**: rows carry `status` (`active|revoked|pending`); `removeMachine` sets
  `revoked`; `isRegistryEntryActive(entry)` (`MachineIdentity.ts:147`) is the predicate.
- **A2A delivery ledger**: `A2ADeliveryTracker` (SQLite), per-message `relay_status`
  (delivered/queued+expires/rejected/expired/unconfirmed), `peerHealth()` with `stale` at 6 h
  (`expiredNewer` rule), `sweepSilence`. Relay `discover` returns the agents currently
  connected.
- **Standby relay forward** (`a2a-cross-machine-route.md`, built): a standby's A2A send is
  forwarded to the machine holding the relay connection. A standby's relay is `disconnected`
  BY DESIGN (one connection per identity; a second displaces the first).
- **Telegram origin**: `TelegramOriginService` (admit → claim → authorize → execute); durable
  store whose `recordOperationState` accepts `held|suppressed|expired|admitted` and whose
  `expireOperation` writes `expired-unresolved` — neither called from the hold path; recovery
  schedule (15-min interval, 6 h deadline, 9 attempts); `relayOriginBot` (signed RPCs
  `capabilities` + `submit`, forwards `sendMessage` only); the holder-side `submit` handler
  (`OriginMesh.ts:111-125`) executes WITHOUT running `authorize`.
- **Lease**: `LeaseCoordinator.holdsLease()` / `currentHolder()`; `holdsLease()` is `true`
  on a single machine; right after a respawn the eventual holder reads `false` for a few
  seconds.
- **Config shape**: Telegram-origin settings live in `messaging[].config.messageOrigin` and
  are migrated by the array-aware `migrateTelegramOriginDisplay` (`OriginConfig.ts:30`).
- **File routes**: `NEVER_SERVED_PREFIXES` (code-owned, prefix match), `blockedFilenames`
  (config-editable), routes `read`, `download`, `list`, `link`. `BackupManager` has a
  never-backup list; `.instar/identity.json` is in neither.
- **Migration**: `PostUpdateMigrator.migrate()`; `migrateConfig` adds missing TOP-LEVEL keys;
  `migrateGitignore`, `migrateClaudeMd` exist; dev-gated flags must be in `DEV_GATED_FEATURES`.

## Threat model

- **A hostile or compromised sibling requests the agent identity.** The request must be
  signed by a REGISTERED ACTIVE machine key; the payload is sealed to that machine's REGISTRY
  encryption key (never a key named in the body); one share per requester per 10 min; both
  sides audit. Not mitigated, stated plainly: a legitimate sibling already holds the same
  private key (the parent spec's accepted "compatibility bridge"); rotation remains the only
  revocation (§Out of scope).
- **A fabricated identity is pushed to a machine with none.** Mesh RESPONSES are unsigned
  today and LAN ropes are plain HTTP. Mitigated: the two new verbs' responses are signed by
  the responder's registry-pinned machine key over `{fingerprint, requesterNonce}`; the
  requester verifies before counting an observation or opening an envelope; private↔public
  correspondence is checked in memory before the write; the envelope's fingerprint must equal
  the value every REACHABLE active sibling signed AND this machine's own last-known published
  fingerprint when one is recoverable locally (§1.3).
- **A wrong "canonical" is auto-written over a working identity.** Not possible by
  construction: adoption fills a VOID only. Replacing an existing identity is an operator
  action on that machine's shell (§1.4), with a backup before the rename.
- **A detector that pages on healthy fleets trains the operator to ignore it.** Mitigated by
  §2: one formula and a semantic test that asserts `agree` on identical keys.
- **A notice flood when a peer goes dark or MY relay is down.** Mitigated: one item per peer
  per episode through the EXISTING escalate-once sentinel; one aggregated item when my relay
  is not connected; dry-run first.
- **The forward-to-holder path double-posts or loops.** Mitigated: the holder's `submit` runs
  `authorize`; a forwarded operation keeps its ORIGINAL operation id so the holder dedupes;
  an `outcome-unknown` forward is never re-sent blind; the standby never also executes locally.
- **Key material leaves via a read surface.** Mitigated by §5: a code-owned, config-immune
  deny list checked on the RESOLVED path in `read`/`download`/`list`/`link`, mirrored into
  backup, gitignore and the secret classifier, with a fixture walk that can disagree with it.

## Design

### 1. One identity, adopted from siblings — never minted on a joined machine

**1.1 Close the second mint site.** `createUnifiedTrustSystem` keeps its legacy-migration
branch untouched and guards ONLY the `create()` call with the same `detectJoinedMesh(stateDir)`
predicate `getOrCreate()` uses: no registry file → standalone first machine → mint as today;
a registry naming any other row (any status) → refuse; a registry that exists but is
unreadable → refuse (fail closed, named). A refused mint boots the server in
`identity-not-provisioned` posture: the relay connection is not attempted
(`/threadline/health → relay.state: 'not-provisioned'`, `fingerprint` absent); the machine is
**lease-ineligible** (declines to acquire the serving lease; releases one it holds at the
next tick — an unprovisioned lease holder would take the WHOLE fleet off the network);
`DegradationReporter` writes the row on the same tick; the adoption loop (§1.2) starts
immediately. The operator sees ONE `high` attention item
`agent-identity-missing:<agent>:<machineId>` only after adoption has been refused for a fleet
reason on 4 consecutive rounds or 120 s have passed — whichever first — naming the reason and
the lever (§1.4). Adoption keeps retrying; the item resolves itself on success.

Mint-site census: a unit test enumerates every call site in `src/` of
`generateIdentityKeyPair(`, `CanonicalIdentityManager.create(`/`identity.create(` and
`getOrCreate(` against a code-owned allowlist BY FILE (the two guarded sites must call
`detectJoinedMesh(` in the same function body; the primitives' own bodies and the non-agent
key users `relay/A2ABridge.ts`, `relay/RegistryAuth.ts` are listed). A new unlisted site
fails the build.

**1.2 Post-pairing adoption: two new mesh verbs.** A paired machine with NO identity (no file
at either path, `IdentityManager.get()` null) asks its siblings:

- **Observe** (read, every round): MeshRpc `agent-identity-observe` `{agentName,
  requesterNonce}` → each ACTIVE registered sibling. Response `{fingerprint | null, state:
  'provisioned'|'not-provisioned', requesterNonce, sig}` signed by the responder's
  registry-pinned machine Ed25519 key; an unsigned, mis-signed or nonce-mismatched answer is
  discarded as unreachable. An older sibling answers `no-handler` = unreachable, named in the
  item ("update <nick>").
- **Request** (write): `agent-identity-request` `{agentName, expectedFingerprint,
  requesterNonce}` to ONE sibling that published the value, rotating on a typed refusal,
  never more than once per 10 min, one in flight. Serving refusals, each typed:
  `not-registered`, `no-usable-identity`, `fingerprint-mismatch`, `requester-publishes-identity`
  (the server reads the requester's own observe answer back first — the one void-check it
  can do), `rate-limited` (`retryAfterMs`). Payload: the identity sealed with `encryptForSync`
  to the requester's REGISTRY `encryptionPublicKey`; the signed envelope `{sealed, fingerprint,
  requesterNonce, adoptedFrom: {machineId, at}}`.
- Acceptance (§1.3), then install through `installAgentIdentityFromPairing`'s atomic
  owner-only write after verifying private↔public correspondence IN MEMORY (`keypair-mismatch`
  writes nothing). The `IdentityManager` cache reloads, lease-ineligibility lifts, a normal
  relay connect follows on the next tick — no restart. Identity mutations on a machine are
  serialized by a lock file (`identity.lock`, O_EXCL, pid-stamped, stale after 60 s) shared by
  adoption, the operator CLI (§1.4) and `instar join`.
- Audit: both sides append to `logs/agent-identity.jsonl` on every reason TRANSITION plus an
  hourly heartbeat while refused (fingerprints and machine ids; NEVER key material). The
  adopting machine raises ONE `medium` item `agent-identity-adopted:<agent>:<machineId>:<fp>`
  on success — a key copy is an event the operator must be able to see.
- A joiner that completes `instar join` WITHOUT an envelope (old awake machine) boots in the
  same posture and adopts the same way, instead of today's "update and re-pair".

A separate verb from `secret-share` because the identity is credential-class
(cf. `AccountCredentialShare`), must never ride the general secret set, and needs a signed
response, which `secret-share` lacks.

**1.3 Which identity to adopt: every REACHABLE active sibling agrees, pinned by local memory,
else refuse.** Adopt only when, in one observe round, all of the following hold:

- at least one sibling whose registry row is ACTIVE answered with a VERIFIED signature in
  state `provisioned`;
- every reachable `provisioned` responder published the same fingerprint (`not-provisioned`
  responders — another rebuilt machine — are excluded, not counted as disagreement);
- the sealed envelope's public key hashes (routing formula) to exactly that value;
- when this machine can recover its own LAST-KNOWN published fingerprint from local durable
  state (in order: `threadline/agent-info.json`, the A2A ledger's sender column, the newest
  `identity.json.superseded-*` backup's public key), the value equals it;
  `last-known-mismatch` refuses.

Any disagreement, verification failure or last-known mismatch → refuse, stay unprovisioned,
keep the item open naming the observed set. An UNREACHABLE sibling does not block (the Laptop
and the Mama PC are asleep most hours; a rule that waits for all of them makes the alert the
normal path for every rebuilt machine). The cost is stated: a rebuilt machine whose only
reachable sibling is itself split adopts the split value — a state §2 is already loud about,
with the operator CLI as the fix. Revoked rows are excluded and named in the refusal when
they are the only siblings. The parent spec rejected peer MAJORITY for choosing BETWEEN
candidates; this rule fills a void with the one value the reachable fleet signs for.

**1.4 Replacing an existing identity is an operator shell command, not an automatic path.**
`decideReconciliation` and the dashboard ceremony are NOT wired (§Out of scope). The two
levers, both run in a shell ON the affected machine (a local shell is the operator; audited):

- `instar identity adopt --from <machine-name-or-id>` — requests the identity from the named
  sibling through `agent-identity-request`, verifies as §1.3 does (minus unanimity — the
  operator named the source), backs up the existing file as `identity.json.superseded-<ISO>`
  (owner-only, single writer, under the lock) BEFORE the rename, installs, reloads the cache,
  reconnects the relay. Provenance `adopted-by-operator`. This replaces the 2026-10-09 manual
  file copy, which left disagreeing files and no backup.
- `instar identity init --standalone --i-understand-peers-must-repin` — mints a NEW identity
  on a fleet with no usable candidate (provenance `minted-by-operator-recovery`).
- A decommissioned sibling that answers nothing is removed with `instar machines remove`
  (existing); a present-but-invalid or encrypted identity file is never adopted over by §1.2
  and is moved aside as `identity.json.invalid-<ISO>` only by `identity adopt`.

No network path, PIN or dashboard surface is needed to recover a fleet; the §2 item names the
command and the machine to run it on.

**1.5 The legacy file is a mirror, repaired at first load.** When `IdentityManager.loadFromDisk()`
finds both files and they disagree, the canonical one wins (as today) AND the legacy file is
rewritten to match — by the single writer, under the lock, atomically, old file backed up as
`threadline/identity.json.superseded-<ISO>` — with ONE degradation row. The listener daemon
loads the legacy path as ITS key, so the server signals it to reload after the repair (the
daemon re-reads its key file on SIGHUP; a daemon that is not running is not signalled). Today's
manual fix left exactly this state and the server logs an `[identity]` ERROR at every boot.

### 2. Loud cross-machine mismatch: one formula, one episode, one item

**2.1 One comparison value.** The routing fingerprint (`computeFingerprint`, raw public-key
prefix) is the ONLY value ever compared across machines or against a peer's pin.
`AgentIdentityHandover.fingerprintOf` is changed to it. `canonicalId`/`displayFingerprint`
stay trust-system ids and are never placed in a routing comparison. Transition: a joiner
accepts a join envelope whose `identityFingerprint` matches the sealed key under EITHER
formula (an old awake machine still writes the sha256 form); a provenance `rootFingerprint`
is compared for presence only and rewritten in routing form on the next successful load.

**2.2 The detector, fixed and continuous.** The existing boot task (`AgentServer.ts`) stays —
always on, every machine, no flag (a dark identity check checks nothing) — with these changes:

- the formula fix (its SELF value is read from the on-disk file through the single reader, not
  the in-process cache, so a file repaired without a restart can disagree with the running
  relay client and be caught);
- it runs every 5 min (not once), with an in-flight guard; peers are read as today
  (Bearer `fetch(<peerUrl>/provenance)`, 8 s timeout, one request per active sibling);
- verdict: `disagree` whenever ANY two observed values differ (an unreachable member never
  hides a demonstrated split); `cannot-tell` only when fewer than two values were observed and
  none differ; `agree` only when every ACTIVE sibling was observed and all match;
- item id `agent-identity-split:<agent>:<sorted fingerprint set>`, priority `high`, raised by
  any machine after 2 consecutive `disagree` reads, resolved only by the serving-lease holder
  after 2 consecutive full-set `agree` reads (two observers with different reach cannot churn
  one item). Body: "my machines are not the same me on the agent network — <nick> publishes X,
  the others publish Y; messages addressed to Y are lost while <nick> holds the relay. Fix: on
  <nick>, run `instar identity adopt --from <sibling>`." It resolves itself on `agree`;
- 10 consecutive `cannot-tell` rounds against the same peer, after a self-heal (re-pull that
  peer's presence), produce one degradation row and ONE `medium` item "identity check cannot
  run against <nick>" — a split must not hide behind a slow peer forever;
- `/threadline/health` reports `identityCoherence: {state, connectedAs, siblingsPublish,
  cannotTellRounds, lastCheckedAt}` on every machine.

### 3. Honest sender-side reporting of a send that stays queued

**3.1 Classification.** `A2ADeliveryTracker.peerHealth()` gains `dark` and `darkSince`: a peer
is `dark` when its oldest row that is `awaiting-ack`/`queued`, `unconfirmed`, or
`failed`+`expired` — and NEWER than the last ack and last inbound from that peer — is older
than `queuedDarkAfterMs` (default 2 h, below the 6 h `stale` window so the sender hears first).
A peer leaves `dark` ONLY on an ack, an inbound, or a `delivered` verdict (the existing
`expiredNewer` shape; relay expiry alone never clears it, so a persistently dark peer is one
episode, not one per day). `allPeerHealth` is bounded to peers active in the last 30 days.

**3.2 Where it is said.**

- **In the send response.** `POST /threadline/relay-send` (and the `threadline_send` tool
  result, additive) answers a send to a dark peer with `peerDark: {since, queuedCount,
  expiresAt, connectedNow}` — `connectedNow` from the relay's `discover` list (the relay's own
  present-tense view: in the list = connected now; absent = not connected now; `discover`
  failing = `null`, unknown). The `deliveryOutcome` SENTENCE — "no acknowledgement from <peer>
  for N h; this and K other messages are still queued (oldest expires T); <peer> is not
  connected to the relay right now — it may be offline, or listening under a different
  address" — is worded to the evidence (never "nothing will arrive") and rides the dry-run
  flag. Peer names render as fingerprint prefix + clamped, HTML-escaped display name.
- **On the health read.** `GET /threadline/peers/health` and the per-peer route carry `dark`,
  `darkSince`, `queuedCount`; pool scope merges as today.
- **To the operator, once — through the EXISTING sentinel.** `A2ARedeliverySentinel` already
  escalates once per peer with one aggregated item and has an escalate-only mode. §3 builds no
  second notifier: `dark` becomes the sentinel's trigger in escalate-only mode (`redeliver`
  omitted; trigger = `dark && queuedCount > 0 && selfHealExhausted`), item id
  `a2a-peer-dark:<agent>:<peerFp>:<darkSince>` (replacing `a2a-redelivery-${Date.now()}`).
  Body: "Messages to <peer> are stuck: K queued since T, none acknowledged. <peer> may be
  offline, or listening under a different address." Resolves when the peer leaves `dark`;
  per-peer cooldown 12 h.
- **Aggregation when the cause is local.** If my own relay is not `connected`, ONE aggregated
  item ("relay unreachable from this machine; K peers, M messages queued") and per-peer items
  are suppressed until it is back.

**3.3 The self-heal, and where it may run.** Before blaming the peer, fix my side — ONLY on the
awake (telegram-polling) machine, because a standby's relay is `disconnected` by design and
reconnecting it would displace the live holder: (1) if my relay is `disconnected`/`displaced`,
`reconnectRelay()` (idempotent, the existing re-arm); (2) re-issue `discover`; (3) run the §2
self-check — if I am the split one, that item supersedes this. On a standby the heal is skipped
with reason `standby`. Two passes 40 s apart inside the 120 s ceiling.

**3.4 Rollout.** `threadline.peerDarkNotice: {dryRun: true, queuedDarkAfterMs: 7200000,
cooldownMs: 43200000}`, `enabled` OMITTED (dev-gate resolution; in `DEV_GATED_FEATURES`).
Dry-run logs would-raise and would-sentence rows to `logs/a2a-peer-dark.jsonl`; the raw
fields (`dark`, `darkSince`, `queuedCount`, `peerDark.connectedNow`) are live from the first
build — they are reads.

### 4. ACT-058 — a reply from a non-lease machine is forwarded; a failed forward is held durably and reported

**4.1 Forward before hold.** The send decision in `TelegramAdapter.sendToTopic` (and its mirror
`willRelay()`) becomes "no usable bot token OR (session pool enabled AND `!holdsLease()`)". A
standby that owns a topic sends its reply through `telegram.outboundRelay` → `relayOriginBot`
to the lease holder, preparing the operation with `executionOwnerMachineId = holder`. The
holder-side `submit` handler gains the SAME `authorize` (lease) check the direct path runs and
answers a typed `not-lease-holder` refusal when it does not hold the lease (today it executes
unchecked). The holder records `deliveryMachineId = holder`, `forwardedFromMachine = standby`;
the reply lands with its normal origin footer. The standby never also executes locally. v1
forwards `sendMessage` only; media, edits and pins from a standby go to the durable, reported
hold of §4.2.

**4.2 Settle, retry, then a durable hold that says so.**
- **`lease-settling`.** When `leaseHolder` is null, or equals self while `holdsLease()` is
  false (the seconds after a respawn), re-read the lease with backoff for ≤60 s BEFORE writing
  anything. Settles to self → send locally; to a peer → forward. No row, no notice.
- **Ladder.** A forward refused with a typed `retryable` reason (holder busy, timeout,
  `not-lease-holder` because the lease just moved) is retried 3× at 10 s, re-resolving the
  holder each time.
- **Durable hold.** Only `forward-to-holder-failed` holds: the EXISTING
  `recordOperationState('held')` is called with a new `hold_reason` = `lease-not-held` —
  distinct from `destination-not-authorized`, which keeps meaning "foreign chat" and is never
  forwarded or notified. The in-memory held map becomes a cache of the store; an older reader
  treats an unknown `hold_reason` as `admitted` (additive).
- **Recovery re-forwards the SAME operation** (original operation id and sealed record; the
  holder dedupes). On a holder change while an attempt is `outcome-unknown`, it queries the old
  holder's origin `status` and stays held `effect-unknown` until that answers or the deadline
  passes — never a blind re-send.
- **The notice.** The fixed outage template ("I have your message; my reply is delayed while
  it is routed through <holder nickname>") is sent THROUGH the holder. If the holder cannot be
  reached for the notice either: `/health` carries `telegramOrigin.heldForward`,
  `/telegram/origins/status` lists it under `held` with `hold_reason: lease-not-held`, and ONE
  `high` item `telegram-origin-held:<topic>` names the topic and holder; three topics held on
  one standby within 1 h collapse to one item.
- **Expiry is reported.** A held operation reaching its deadline goes through the EXISTING
  `expireOperation` (`expired-unresolved`) and re-raises the item once with honest wording
  ("I could not deliver my reply to <topic> within 6 h" vs "my reply may or may not have been
  delivered; the sending machine did not confirm").

**4.3 Rollout.** `messaging[].config.messageOrigin.forwardToHolder: {enabled: true}` added by
extending the array-aware `migrateTelegramOriginDisplay`. Live, no dry-run: reachability is a
safety floor the constitution forbids dark-shipping ("The Agent Is Always Reachable",
corollary 2), the holder dedupes on operation id so a bug cannot double-post, and the kill
switch restores today's hold — now durable and reported (the durable `held` state, the reason
and the notice are NOT behind the flag; a silent hold is the defect). Single-machine agents
are a strict no-op (`holdsLease()` is always true). The pool ownership-record divergence also
named in ACT-058 stays with ACT-058 (§Out of scope); §4 makes a standby-owned topic
answerable regardless.

### 5. Key material is never served, backed up or listed — by lists the config cannot loosen

**5.1 Extend the code-owned deny list.** `NEVER_SERVED_PREFIXES` gains, as PATH PREFIXES:
`.instar/identity.json` (covers `.superseded-*`/`.invalid-*` siblings and the writer's temp
names, which share the prefix), `.instar/threadline/identity.json`,
`.instar/threadline/inbox-hmac.key`, `.instar/threadline/invitation-secret.key`,
`.instar/threadline/secure-invitations.json`, `.instar/machine-ssh/`,
`.instar/state/inbound-delivery.hmac-key`, `.instar/relay-tokens.json`, `.instar/local-state/`,
`.instar/origin-sessions-`, `.instar/state/conversation-bind-token.secret`. Only the KEY files
under `.instar/threadline/` are denied, not the directory (`conversations.json`,
`trust-profiles.json` and thread history are the operator's own audit surfaces). The list is
config-immune: `PATCH /api/files/config` can narrow `allowedPaths` but never remove a
never-served entry. This is exact-path access control, not a meaning filter (Signal vs.
Authority does not apply to an enumerated floor).

**5.2 Check the resolved path, everywhere.** The never-served and `blockedFilenames` checks
run on BOTH the requested path and the `realpath`-resolved one, in `read`, `download`, `list`
(realpaths EACH entry, so a symlink with an innocent name is hidden) and `link`. A `realpath`
failure refuses.

**5.3 The same list guards the other read surfaces.** The same prefixes are added to
`GITIGNORE_ENTRIES` (with a `migrateGitignore` step), to `DEFAULT_SECRET_PATTERNS` in the
file classifier (as prefixes, so backups are classified), and to `BackupManager`'s
never-backup list (an operator adding `identity.json` to `backup.includeFiles` must not ship
the key in a snapshot).

**5.4 A walk that can disagree with the list.** One behavioural test boots a fixture agent home
through the real init path, pairs it to a stub sibling so every key-bearing file is produced,
walks `.instar/` for files with mode 0600 or JSON carrying a `privateKey`/`secretKey` field,
and asserts each is refused by `read`/`download`/`list`, excluded from backup, gitignored and
secret-classified. A new key file the list does not cover fails the build.

**5.5 No flag.** A security floor; ships live. A one-line release note says what became
unreadable through the Files tab.

## Decision points touched

| Decision point | Change | Classification |
|---|---|---|
| `createUnifiedTrustSystem` canonical mint | new refusal when `detectJoinedMesh` names a sibling or the registry is unreadable; boots `identity-not-provisioned` | invariant — an on-disk fact decides; no competing signal; the human lever is the local CLI (§1.4) |
| `identity-not-provisioned` → lease-ineligible | new | invariant — a machine with no routing identity cannot serve the relay |
| `agent-identity-request` serving refusals | new | invariant — deterministic predicates on local state or a signed read; the verb hands out a private key, so no judgment may widen it |
| Adoption acceptance (§1.3: reachable-active agreement + last-known pin) | new | invariant — deliberately: choosing an identity is the irreversible act this spec exists to stop being guessed; the only other path is the operator's shell command |
| Identity-divergence verdict (`agree`/`disagree`/`cannot-tell`) | changed: one formula, every 5 min; `disagree` on any two differing values | invariant — equality of published fingerprints; `cannot-tell` on insufficient observation never pages |
| Per-peer `dark` classification (§3.1) | new signal | invariant — a time threshold over ledger rows; signal-only; thresholds are config |
| `a2a-peer-dark` raise (via `A2ARedeliverySentinel` escalate-only) | changed trigger + deterministic id | invariant — raise iff `dark && queuedCount>0 && selfHealExhausted`; wording carries honest uncertainty |
| `sendToTopic` / `willRelay()` | modified: also forward when the pool is on and `!holdsLease()`, after `lease-settling` | invariant — the existing deterministic lease reads |
| Holder `submit` handler | new `authorize` check → typed `not-lease-holder` | invariant — the same predicate the direct path runs |
| Origin hold reasons | `lease-not-held` (new; forwardable, notifiable) vs `destination-not-authorized` (unchanged; never forwarded) | invariant — two facts, two reasons |
| File-route never-served list + resolved-path check | new denials in `read`/`download`/`list`/`link`, backup, gitignore, classifier | invariant — a code-owned path list; security floor; exact-path access control |

Nothing here grants authority: a shared identity is a routing key, not a permission; a
forwarded reply is still subject to the holder's full outbound gate; an adopted identity does
not establish an operator.

## Multi-machine posture

Default posture is `unified`. Each surface this spec introduces:

- **The agent identity itself** — `unified`: one keypair, replicated through the sealed
  handover (join) and adoption (§1.2); the on-disk file is a per-machine COPY of one identity,
  verified equal by §2 every 5 min.
- **`identity-not-provisioned` posture** — `unified` by construction: exists only on the
  machine lacking the identity, makes it lease-ineligible, ends when the fleet's identity lands.
- **`logs/agent-identity.jsonl`** — proxied-on-read: `GET /agent-identity/audit` (Bearer,
  read-only; `?scope=pool` merges online machines' rows tagged by machineId, dark-peer
  tolerant; `?limit` default 200).
- **Divergence verdict / `identityCoherence`** — every machine computes it; one shared item id
  (raise anywhere, resolve only on the lease holder) makes the notice unified; the read is
  per machine on `/threadline/health`.
- **A2A delivery ledger + `dark`** — proxied-on-read: rows live on the machine that carried
  the send (the relay holder); `GET /threadline/peers/health?scope=pool` merges (existing).
  The item is raised by the awake machine (the only one whose heal may run).
- **Telegram origin held operation on a standby** —
  `machine-local-justification: physical-credential-locality` — the held record is an origin
  operation ATTESTED under the standby's machine signing key, which lives on that disk; the
  design moves the WORK (the forward) to the holder, not the record, and the record is
  visible from the pool via `/telegram/origins/status?scope=pool` (existing).
- **Relay connection** — unchanged: one per agent identity, on the awake machine
  (`physical-credential-locality`, pre-existing).
- **Never-served / never-backup / gitignore / classifier lists** — identical code on every
  machine; `unified` by construction.
- Rolling update: a sibling answering `no-handler` to a new verb is unreachable for adoption
  and named; an older peer's `/provenance` still answers the (now matching) routing formula.

## Watchers, self-heal and escalation (Self-Heal Before Notify)

| Watcher | Class | Self-heal + remediation-actions | Brakes | Escalation |
|---|---|---|---|---|
| **Missing identity on a joined machine** (§1.1) | `recoverable` | adoption: signed observe → reachable-active agreement + last-known pin → one signed request → in-memory keypair check → atomic install under the lock → cache reload → lease-eligible → relay connect. Idempotent (a second install of the same fingerprint is a no-op; a failed install writes nothing); no compensation needed (no file existed). | observe cadence 30 s, backing off to 5 min after 1 h (one signed read per active sibling per round); requests ≤1 per 10 min, one in flight; dedupe-key `agent-identity-missing:<agent>:<machineId>`; breaker: 4 consecutive FLEET refusals (`rate-limited` excluded) → escalate; flapping: 3 adopt→lose cycles in 24 h → `critical`; max-notification-latency `120s`; audit `logs/agent-identity.jsonl` | `high` item after 4 fleet refusals or 120 s; names reason + lever; heal continues; resolves on success |
| **Identity split between machines** (§2.2) | `data-loss` (peers' messages are queued and expired) | none automatic for an EXISTING split — the heal is the operator's `instar identity adopt` on the named machine; the comparison re-runs every 5 min so the repair resolves the item without operator action | dedupe-key `agent-identity-split:<agent>:<sorted fp set>`; confirm 2 consecutive `disagree`; resolve: lease holder only, after 2 consecutive full-set `agree`; cannot-tell never pages (10 consecutive → one `medium` item after a presence re-pull); max-notification-latency immediate on confirmation (`≤10min`, the cadence); audit `logs/agent-identity.jsonl` | immediate `high` on confirmation (data-loss class: notify-and-heal); resolves on confirmed `agree` |
| **Dark peer with queued sends** (§3, via `A2ARedeliverySentinel` escalate-only) | `recoverable` | on the AWAKE machine only: (1) relay `disconnected`/`displaced` → `reconnectRelay()` (idempotent); (2) re-issue `discover`; (3) run the §2 self-check (if I am the split one, that item supersedes); standby: skipped, reason `standby` | 2 heal passes 40 s apart (≤120 s); dedupe-key `a2a-peer-dark:<agent>:<peerFp>:<darkSince>`; cooldown 12 h per peer; aggregation: relay not connected → ONE item, per-peer suppressed; max-notification-latency `120s` after the dark threshold; audit `logs/a2a-peer-dark.jsonl` (fp, counts, timings; never bodies) | `medium` item after heal exhausted; resolves on first ack/inbound/`delivered` |
| **Held forward on a standby** (§4.2) | `recoverable` (the reply is durable) | `lease-settling` re-reads (≤60 s, no row); ladder 3×10 s re-resolving the holder; then re-forward the SAME operation on the recovery schedule; idempotent on the operation id (holder dedupes); an `outcome-unknown` attempt is never re-sent — it queries the old holder's status and stays held | max-attempts 9, 15-min schedule, max-wall-clock 6 h (existing); dedupe-key `telegram-origin-held:<topic>`; breaker: 3 topics held on one standby in 1 h → one aggregated item; max-notification-latency `120s` from `forward-to-holder-failed` (never from settling); audit: origin store attempt rows + `logs/telegram-origin-held.jsonl` | user template via the holder at ≤120 s; `high` item when the holder cannot be reached for the notice; expiry recorded durably and re-raised once |

`standards.selfHealBeforeNotify.recoverableLatencyCeiling` is not present in
`docs/STANDARDS-REGISTRY.md` at `e76caca6a`; a missing ceiling fails closed, so every
recoverable latency above is `120s`.

## Evidence each check relies on (symbol → state)

| Check | Symbol read | State claimed | Independent corroboration | When unmeasurable |
|---|---|---|---|---|
| Joined-machine detection (§1.1) | `.instar/machines/registry.json` lists a row other than own id | this agent already has an identity elsewhere | the §1.2 observe round — a sibling answering with a signed fingerprint proves it | no registry file → mint (audited); registry present but unreadable → `joined` (fail closed, named) |
| Adoption acceptance (§1.3) | each reachable ACTIVE sibling's signed observe answer; this machine's last-known fingerprint from local files | the fleet publishes one identity, and it is the one this machine used | the sealed envelope's public key hashing to the same value under the serving machine's registry-pinned signature, plus the in-memory private↔public check — a sibling cannot serve a key it does not hold | no sibling reachable/signed → refuse (`cannot-tell`); no local memory → the pin is skipped and the item says so |
| Divergence verdict (§2.2) | each sibling's `/provenance` fingerprint; own value from the on-disk file via the single reader | all copies of the identity are the same key | a peer's own report (its §3 dark-peer notice on their side) is the out-of-process check this spec relies on — stated, not implied (§Out of scope names the relay-side corroboration) | peer unreachable → `cannot-tell` for that peer, never `agree`; 10 consecutive → one item |
| `dark` peer (§3.1) | ledger rows: oldest un-acked row newer than last ack/inbound | the peer is not receiving | the relay's `discover` list (`connectedNow`) and my own relay state (a disconnected sender makes every peer look queued — checked FIRST in the heal) | ledger unreadable → `dark: unknown`, no item, degradation row; `discover` failing → `connectedNow: null`, never "never connected" |
| Standby forward outcome (§4) | the holder's receipt for the forwarded operation id | the reply was sent from the holder | the holder's origin record (`deliveryMachineId`, Telegram message id) via `/telegram/origins/:id`; the `status` action on a holder change | no receipt within the timeout → `effect-unknown`, stays `held`, never replayed blind, never marked delivered |
| Never-served (§5) | requested path + `realpath` against the prefix list | the file is not key material | the behavioural fixture walk (0600 files / `privateKey` fields) — which can disagree with the list | `realpath` fails → refuse; the walk finding an undenied key file → build failure |

## Frontloaded Decisions

1. **One comparison formula — the routing fingerprint — everywhere an agent identity is
   compared.** NOT cheap (it changes what the detector claims). A join envelope is accepted
   under either formula during the transition.
2. **Both mint sites use `detectJoinedMesh`; an unreadable registry refuses; a joined machine
   with no identity boots unprovisioned AND lease-ineligible.** NOT cheap (identity). The
   mint-site census is an allowlist by file.
3. **Adoption fills a VOID and never replaces.** Invalid, locked or encrypted files are never
   written over; replacement is the operator's shell command with a backup before rename. NOT
   cheap (identity).
4. **Adoption needs agreement of every REACHABLE active sibling (≥1 provisioned, signed),
   cross-checked against this machine's last-known fingerprint; an unreachable sibling does
   not block.** NOT cheap (identity). Waiting for ALL active siblings was rejected because in
   this fleet two machines are asleep most hours, which would make the escalation the normal
   path; the accepted cost (adopting from a split-but-only-reachable sibling) is the state §2
   already reports loudly.
5. **The identity rides two dedicated signed mesh verbs, sealed with the existing
   `encryptForSync` to the requester's REGISTRY X25519 key, audited both sides, announced once
   by the adopter.** NOT cheap (key custody). `secret-share` rejected (unsigned responses).
6. **No dashboard ceremony, no replace mandate, no replicated commit record.** Replacement and
   fleet recovery are `instar identity adopt --from <machine>` and `instar identity init
   --standalone`, run on the machine's shell. NOT cheap (identity); decided here.
7. **The legacy `threadline/identity.json` is a mirror repaired at first load, with backup,
   and the listener daemon is signalled.** NOT cheap (that daemon's key).
8. **The detector stays on its existing `/provenance` read, every 5 min; any machine raises,
   only the lease holder resolves; `disagree` whenever any two observed values differ.** NOT
   cheap (alert semantics). Adding the fingerprint to the coherence advert / the
   MachineCoherence `identity` dimension was cut (§Out of scope): three requests every five
   minutes do not justify new advert plumbing.
9. **Dark-peer reporting rides the EXISTING `A2ARedeliverySentinel` in escalate-only mode with
   a deterministic item id; `connectedNow` comes from the relay's `discover` list, not a new
   relay field.** The raw `peerDark`/`dark` field NAMES are NOT cheap (a published interface).
   The thresholds (`queuedDarkAfterMs` 2 h, cooldown 12 h) and the dry-run gate on the
   sentence AND notice are cheap-to-change-after: a wrong threshold costs a log row until the
   flip.
10. **A standby forwards its origin sends to the lease holder after a bounded `lease-settling`
    window and a 3×10 s ladder; only a failed forward holds, durably, with `lease-not-held`, a
    notice through the holder, a `/health` degradation and one item; the holder's `submit`
    runs `authorize`.** NOT cheap (reachability). Ships live with a kill switch, no dry-run.
11. **Key material is denied by code-owned, config-immune lists (routes, backup, gitignore,
    classifier) checked on the resolved path, with one behavioural fixture walk.** NOT cheap
    (security surface); no flag. The static `KEY_FILE_MANIFEST` ratchet was cut (§Out of
    scope): the walk is the arm that can disagree with the list.
12. **Under `.instar/threadline/`, only the key-bearing files are never-served.** NOT cheap.
13. **The operator is never notified before self-heal has run** (missing identity → adoption
    first; dark peer → fix-my-side first; held forward → settle + ladder + re-forward first);
    the identity SPLIT is the one `data-loss` class and escalates on confirmation. NOT cheap.
14. **Config placement and names**: `messaging[].config.messageOrigin.forwardToHolder
    {enabled}` (array-aware migration); `threadline.peerDarkNotice {dryRun, queuedDarkAfterMs,
    cooldownMs}` (dev-gated, in `DEV_GATED_FEATURES`); `agentIdentity.adoption {enabled: true}`
    (top-level, FLEET-LIVE kill switch, not dev-gated). Item ids as named in §1–§4; priorities
    from the real enum. NOT cheap (published names).
15. **No relay change** (no `recipientLastSeenAt`, no orphan retirement — CMT-026). NOT cheap.

## Tests (Testing Integrity Standard — all three tiers)

| AC | Criterion | Test |
|---|---|---|
| AC1 | A joined machine with no identity never mints at boot and boots lease-ineligible; a standalone first machine still mints | `agent-identity-mint-guard.test.ts` (unit); E2E boot |
| AC2 | An identity-less paired machine adopts the reachable fleet's agreed identity over signed responses and connects as it; a disagreement, forged answer, keypair mismatch or last-known mismatch refuses with the named reason | `agent-identity-adoption.test.ts` (unit); two-server integration |
| AC3 | Four machines holding the same key read `agree`; the 63b1/afd2 pair reads `disagree`; one unreachable member with two differing observed values reads `disagree`; the item is raised once and resolved by the lease holder | `agent-identity-fingerprint-formula.test.ts` |
| AC4 | `instar identity adopt --from` backs up, installs, reconnects; `init --standalone` mints with the recovery provenance; a disagreeing legacy mirror is repaired with a backup | `agent-identity-operator-cli.test.ts`; `agent-identity-legacy-mirror.test.ts` |
| AC5 | A dark peer yields one item through the existing sentinel; relay expiry does not clear `dark`; a local relay outage yields one aggregated item; a standby runs no heal; the send response carries `peerDark` with `connectedNow` from `discover` | `a2a-peer-dark.test.ts` |
| AC6 | A standby's reply reaches the topic via the holder; a settling window never holds; a failed forward holds durably with `lease-not-held`, notice via holder, one item; retries never double-post; `destination-not-authorized` is never forwarded | `telegram-origin-forward-on-standby.test.ts`; integration |
| AC7 | Every key-bearing file produced by a real init+pair is refused by `read`/`download`/`list`/`link` (direct path, symlink, dangling symlink), excluded from backup, gitignored and secret-classified; `PATCH /api/files/config` cannot remove a never-served entry; `conversations.json` still serves | `file-routes-never-served.test.ts` (static + behavioural walk) |

**Tier 1 — unit (`tests/unit/`)**: the seven files above. `agent-identity-fingerprint-formula`
uses REAL keys (not opaque strings) and asserts `fingerprintOf(pub) === computeFingerprint(pub)
=== /provenance` and that the sha256 form never equals them. `agent-identity-adoption` covers:
unanimity of reachable → adopt; one unreachable → still adopts; one disagreeing → refuse;
unsigned/nonce-mismatched → discarded; `no-handler` → unreachable, named; envelope key not
hashing → refuse; keypair-mismatch → nothing written; last-known-mismatch → refuse; serving
side refuses a requester whose own observe carries a fingerprint, an unregistered sender, a
`fingerprint-mismatch`, and rate-limits; the lock serializes a concurrent install; audit rows
never contain key bytes (byte-scan). Mint-site census passes the allowlist and fails on an
injected unlisted `generateIdentityKeyPair(` site.

**Tier 2 — integration (`tests/integration/`)**: two in-process servers paired over the real
`/mesh/rpc` — B boots with no identity and a registry naming A, is lease-ineligible, observes
(signed), adopts, connects to a stub relay as A's fingerprint, one `agent-identity-adopted` item
exists; a stub peer publishing a different fingerprint → B refuses and the item names both; a
forged answer is ignored. Stub relay answering `queued` + `discover` without the peer: after the
threshold the send route carries `peerDark`, health shows `dark`, exactly one item exists; an
inbound resolves it. Standby + holder pair with a Telegram stub: the standby's `/telegram/reply`
lands via the holder with `forwardedFromMachine`; holder refuses `not-lease-holder` after a
lease move and the ladder re-resolves; holder down → 409 `telegram-origin-held`
`{hold_reason: lease-not-held}`, listed in `/telegram/origins/status.held[]`, `/health`
degradation; holder back → delivered once (same operation id). File routes + backup +
classifier against a fixture home booted through the real init path and paired to a stub.

**Tier 3 — E2E (`tests/e2e/`)**: the production init path — `/agent-identity/audit`
(+`?scope=pool`), `/threadline/peers/health` with the new fields,
`/threadline/health.identityCoherence` populated after the first check, answer 200 (never 503);
wiring-integrity: the forward dependency, the observe/request handlers, the dark classifier
wired into the sentinel, the identity lock and the never-served lists are real implementations.
Migration E2E: an existing config gains the new defaults (incl. the array-aware origin block),
the gitignore entries land, the CLAUDE.md sections land once and are idempotent.

Live proof (Live-User-Channel Proof Before Done): a throwaway two-agent-home pair on this
Studio exercises adoption (incl. the disagreement refusal and `identity adopt --from`), the
false-alarm regression (identical keys → `agree` on the real detector), a forwarded Telegram
reply into a proof room, and a Files-tab download of `.instar/identity.json` (expect 403).

## Migration parity

- **Config defaults** (`migrateConfig`, top-level keys): `threadline.peerDarkNotice {dryRun:true,
  queuedDarkAfterMs, cooldownMs}` (no `enabled` key); `agentIdentity.adoption {enabled:true}`.
  **Array-aware**: `messaging[].config.messageOrigin.forwardToHolder {enabled:true}` via
  `migrateTelegramOriginDisplay`.
- **Gitignore**: the §5.1 prefixes added to `GITIGNORE_ENTRIES` + idempotent `migrateGitignore`.
- **CLAUDE.md template** (`generateClaudeMd()` + `migrateClaudeMd` content-sniff): §Agent
  awareness below. **Hooks / skills**: none. **Dev-gate registry**: `threadline.peerDarkNotice`.
- **One-time boot repair**: §1.5 mirror repair, §2.1 provenance-root rewrite and §2.2's first
  check run at boot on every updated machine, so today's "two disagreeing files" state heals on
  update.
- **Rolling update**: every new verb/field tolerates an older peer (§Multi-machine posture).
- **Idempotency**: every step checks before writing; the E2E migration test runs twice.

## Rollback

- §1.1: reverting re-opens silent minting on joined machines. Adoption has a kill switch
  (`agentIdentity.adoption.enabled:false`); off, a joined identity-less machine stays
  unprovisioned, lease-ineligible and loud — strictly better than minting. The CLI (§1.4)
  works regardless.
- §1.4: a wrong `identity adopt` is reversed by a second one from the superseded backup's
  machine; nothing deletes an identity file (superseded/invalid files are backed up beside the
  new one, owner-only).
- §2: reverting the formula restores the false alarm; nothing else to unwind.
- §3: flag off → raw fields still populated, no sentence, no notice (today's behaviour).
- §4: `forwardToHolder.enabled:false` → today's local hold, now DURABLE and reported.
- §5: no lever by design; a false positive is fixed by moving the document, not by serving keys.

## Agent awareness (CLAUDE.md template additions)

- **One identity across my machines**: a machine that joins or is rebuilt ADOPTS the agent
  identity from its siblings; it never invents one. On `identity-not-provisioned`, read
  `GET /threadline/health` (`relay.state`, `identityCoherence`) and the
  `agent-identity-missing` item; say which sibling disagreed or was unreachable, never guess.
  Replacing an EXISTING identity is `instar identity adopt --from <machine>` run on that
  machine's shell, never a file copy.
- **"Are my machines the same me on the agent network?"** → `GET /threadline/health →
  identityCoherence` on any machine. A split means peers' messages to me are being queued and
  lost; the item names the machine holding the relay under the wrong address and the command.
- **"Did <peer> get my message?"** → the send response's `relayStatus` AND `peerDark`; a dark
  peer has had messages queued for hours with no acknowledgement and is not connected to the
  relay now — it may be offline, or listening under a different address.
  `GET /threadline/peers/health` → `dark`, `darkSince`, `queuedCount`. Before blaming the
  peer, read my own `relay.state`.
- **"Why was my reply delayed / why did a topic go quiet on my other machine?"** → on a
  machine that does not hold the lease, replies are forwarded to the holder; a failed forward
  is a durable hold in `GET /telegram/origins/status` (`held[].hold_reason: lease-not-held`)
  with one attention item — never a silent drop.
- **Files tab**: identity, machine, SSH and HMAC key files are never served, listed or backed
  up; a 403 on one of these is correct, not a bug to route around.

## Observability

- `logs/agent-identity.jsonl` (mint-refused, adoption transitions, mirror-repaired, operator
  CLI actions, detector verdict transitions; fingerprints only, never key bytes); read
  `GET /agent-identity/audit` (`?scope=pool`, `?limit`, `?since`).
- `GET /threadline/health`: `identityCoherence {state, connectedAs, siblingsPublish,
  cannotTellRounds, lastCheckedAt}`, `relay.state: 'not-provisioned'`.
- `GET /threadline/peers/health`: `dark`, `darkSince`, `queuedCount`; `logs/a2a-peer-dark.jsonl`.
- `GET /telegram/origins/status`: durable `held` with `hold_reason`; `/health →
  telegramOrigin.heldForward`; `logs/telegram-origin-held.jsonl`.

## Out of scope (each with its carrier)

Cut from this spec under the 80/20 direction (2026-10-09); each is filed as an evolution
action at build time with this spec as origin, unless a carrier already exists:

- **Dashboard reconcile ceremony** (plan/commit routes, PIN, signed replace mandates,
  replicated commit record, `decideReconciliation` wiring) — carrier: the parent spec's open
  AC6/AC7b; the operator CLI (§1.4) is the v1 path.
- **Join-time pin** (`afp` pairing-URL parameter, `--agent-fingerprint`, `fingerprintFormula`
  envelope stamp) — the join envelope is accepted under either formula; a wrong envelope is
  caught by §2 within 10 min.
- **Coherence-advert `agentFingerprint` field + MachineCoherence `identity` dimension** — the
  detector keeps its direct `/provenance` read.
- **Out-of-process corroboration** (relay registry self-lookup, inbound recipient
  fingerprints) — a unanimous-but-wrong fleet is reported by the PEER's §3 notice on their side.
- **Relay-side `recipientLastSeenAt` on queued acks; relay orphan retirement** — CMT-026.
- **Static `KEY_FILE_MANIFEST` ratchet at the single writer** — the fixture walk (§5.4) is the
  v1 guard.
- **Dark-peer flap detection ("intermittent"), ≥2-peers-crossing aggregation** — the per-peer
  12 h cooldown bounds the surface in v1.
- **`capabilities` RPC cache per lease epoch; forwarding media/edits/pins from a standby** —
  v1 forwards `sendMessage`; the rest holds durably and is reported.
- **Rotation of the agent identity across the fleet / per-device certificates**; **at-rest
  passphrase for the canonical key** — the parent's accepted-cost boundary, now two incidents
  old; evolution actions `agent-identity-rotation-and-device-certs`,
  `agent-identity-at-rest-passphrase`.
- **The pool ownership-record divergence** also named in ACT-058 — stays with ACT-058 (WS1.3
  reconciler).

## Open questions

*(none)* — every question is resolved in Frontloaded Decisions.

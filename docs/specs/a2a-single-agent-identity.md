---
title: "A2A single agent identity — one identity across all machines, kept converged, loudly checked, honestly reported"
slug: "a2a-single-agent-identity"
author: "echo"
status: "draft"
origin: "CMT-706 (Justin, Telegram topic 9210, 2026-10-09): 'Find a robust solution so agent identity mismatches are NEVER an issue for agent-to-agent communication.' Incident 2026-10-08 / ACT-058."
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "Verify the State, Not Its Symbol; No Silent Degradation; The Agent Is Always Reachable; Know Your Principal — An Unverified Identity Is a Guess; Structure > Willpower; Close the Loop"
parent-spec: "docs/specs/agent-identity-continuity-on-expansion.md"
related-specs: "docs/specs/machine-coherence-guard.md; docs/specs/a2a-cross-machine-route.md; docs/specs/cross-machine-secret-sync-spec.md; docs/specs/threadline-identity-single-writer.md; docs/specs/threadline-duplicate-identity-resolution.md; docs/specs/machine-self-assertion.md"
eli16-overview: "docs/specs/a2a-single-agent-identity.eli16.md"
review-convergence: "pending"
approved: false
---

# A2A single agent identity

One agent, one identity, on every machine — and when that is not true, the agent says so
before a peer has to.

## Problem

### The incident (2026-10-08)

Echo runs on four machines. Three of them (the Mini, the Laptop, the Mama PC) publish
routing fingerprint `63b1dbb2…`, the value every peer has pinned for Echo since May. The Mac
Studio had minted its own canonical identity (`.instar/identity.json`, created 2026-08-26,
routing fingerprint `afd256bc…`). The Studio also held the serving lease and therefore the
one relay connection the agent is allowed. So for every day of that overlap:

- peers addressed `63b1dbb2…`, which no machine had connected to the relay as;
- the relay answered them `queued` (it queues for any fingerprint that is not connected right
  now, and holds the message for 24 h), then silently expired each one;
- the Studio sat connected as `afd256bc…`, an address nobody had pinned, and received nothing.

Dawn's messages from 2026-10-05 onward were lost. Nothing on Echo's side reported it, and
nothing on Dawn's side could tell "offline for a while" from "no one will ever receive this".
It was fixed by hand on 2026-10-09: the Mini's `.instar/identity.json` was copied onto the
Studio (the server signs onto the relay from that file, not from
`.instar/threadline/identity.json`) and the server restarted. The superseded Studio key was
not backed up, so the `afd256bc…` row on the relay is now an unreachable orphan.

This is the SECOND split of the same machine. The parent spec
(`agent-identity-continuity-on-expansion.md`, approved 2026-08-19) was written for the first
one — the Studio publishing `ae6feac6…` on 2026-08-19 — and it shipped a join-time carry
(`#1946`, `#1947`, 2026-08-19/20). The Studio minted `afd256bc…` on 2026-08-26, six days
AFTER that guard landed.

### Why the parent spec did not prevent the second split (confirmed in code)

Each of these is a measured fact about the tree at `5b36623a9`, not an inference:

1. **The guard protects the wrong mint site.** The parent's §2 guard lives in the Threadline
   client's `getOrCreate()` (`src/threadline/client/IdentityManager.ts:88-118`) and refuses to
   mint when `detectJoinedMesh()` finds a sibling in the machine registry. But the server boots
   the unified trust system FIRST, and `createUnifiedTrustSystem`
   (`src/threadline/UnifiedTrustWiring.ts:86-105`) calls `CanonicalIdentityManager.create()`
   whenever `.instar/identity.json` is absent — with no join check at all. The canonical file
   then exists, the guarded `getOrCreate()` finds it, and the guard never fires. On a joined
   machine whose join-time handover did not land (or whose agent home was rebuilt), this
   mints a second identity at boot every time.
2. **There is no path to obtain the identity after pairing.** `installAgentIdentityFromPairing`
   (`src/core/AgentIdentityHandover.ts:273`) runs only inside `instar join`. A machine that is
   already paired and has lost (or never received) its identity has no way to ask a sibling for
   it. The parent's §3 reconciler, `decideReconciliation`
   (`src/core/AgentIdentityReconciler.ts:60`), is pure and **has no callers**. The operator
   selection protocol the parent designed was never wired to anything.
3. **The split detector compares two different fingerprint formulas, so it can never report
   agreement.** The boot detector in `AgentServer.ts:2909-2990` computes its own value with
   `fingerprintOf` = `sha256(pub).slice(0,32)` (`AgentIdentityHandover.ts:198`) and compares it
   with each peer's `/provenance` value, which is the raw public-key prefix
   `pub.toString('hex').slice(0,32)` (`src/server/routes/provenance.ts:71`) — the same formula
   the relay, `/threadline/health` and every pinned peer use (`computeFingerprint`,
   `src/threadline/client/MessageEncryptor.ts:80-82`). Computed from the live public key on
   2026-10-09: raw prefix `63b1dbb21646e2f5f860441f6c6443ad`, sha256 form
   `ff2e6980b7829e30a96e09c1a77298e9`. Today, with all four machines REPAIRED and agreeing,
   the server log says `[identity-divergence] SPLIT: 63b1dbb2… vs ff2e6980…` — a false alarm
   on a healthy fleet, and the same detector produced the same "split" verdict throughout the
   six weeks the fleet was genuinely split. A detector that fires identically on healthy and
   broken states is not a detector; it was ignored for exactly that reason.
4. **The join-time pin is never set.** The parent's §1 has the joiner pin the agent fingerprint
   before accepting an envelope. `JoinOptions.agentFingerprint` (`src/commands/machine.ts:424`)
   is never populated: `instar join` (`src/cli.ts:2164-2170`) has no such option. The pin
   falls back to the envelope's own fingerprint, which pins nothing.
5. **The relay's `queued` is indistinguishable from "nobody will ever receive this".** The relay
   queues for any fingerprint not currently connected (`RelayServer.ts:1060-1080`,
   `OfflineQueue.enqueue`), never consults its registry, and tells the sender only a TTL.
   The sender's own ledger (`A2ADeliveryTracker`) marks a peer `stale` after 6 h, but that is a
   read-only field on `GET /threadline/peers/health`. The one thing that could speak — the
   `A2ARedeliverySentinel` — ships `enabled: false`, raises a non-deduped item, and conflates
   "resend" with "report".
6. **A reply from a machine that does not hold the lease is held forever, silently.** With the
   session pool on, a topic is legitimately owned by a standby machine. Its replies go
   through `TelegramOriginService`, whose `authorize` requires `holdsLease()`
   (`TelegramOriginBoot.ts:139`). The hold (`#hold`, reason `destination-not-authorized`) keeps
   the payload in a per-process map, leaves the durable state at `admitted` (never `held`), is
   excluded from the outage-notice callback (`TelegramOriginRuntime.ts:128-143`), and is
   retried every 15 min by a recovery tick that is not lease-gated — so a standby re-holds its
   own message nine times and then drops it from memory. The forward-to-holder primitive
   (`relayOriginBot`, `OriginMeshRelay.ts`) exists but is only used when the adapter has NO bot
   token (`TelegramAdapter.ts:664`); a standby that has the token takes the direct path and is
   held. This is ACT-058 (observed 2026-10-08 on topic 122413: two operator messages
   unanswered, no notice).
7. **The Files tab hands out private keys.** `GET /api/files/download` (`fileRoutes.ts:859-907`)
   streams any file under the project dir that passes the config-immune `NEVER_SERVED_PREFIXES`
   and the config-editable `blockedFilenames`. Neither covers `.instar/identity.json` (the
   canonical Ed25519 private key, stored in plaintext because the boot path passes no
   passphrase) or `.instar/threadline/identity.json` (the legacy private key). Also uncovered:
   `.instar/machine-ssh/*-ed25519-g*` (SSH private keys), `.instar/state/inbound-delivery.hmac-key`,
   `.instar/relay-tokens.json`, `.instar/local-state/keys.enc`. The basename check runs on the
   REQUESTED name, not the resolved one, so a symlink defeats `*.key`. Any Bearer holder —
   every session, every script, every dashboard PIN exchange — can download the agent's
   signing identity.

### The shape of the failure

Every item above is the same defect at a different layer: a symbol was trusted in place of
the state it stands for (the guard assumed one mint site; the detector assumed one formula;
"queued" was read as "will arrive"; `admitted` was read as "will be sent"; "allowed path" was
read as "safe to serve"). The fix is therefore not one patch but a set of structural
guarantees, each verified against live state and each with a test that fails when the
guarantee is absent.

## What exists (verified at `5b36623a9`)

- **Canonical identity**: `CanonicalIdentityManager` (`src/identity/IdentityManager.ts`),
  file `.instar/identity.json` = `{version, publicKey, privateKey, privateKeyEncryption,
  keySalt?, canonicalId, displayFingerprint, createdAt, …}`, written atomically owner-only.
  `canonicalId` is `sha256("instar-agent-id-v1" ‖ pub)`; `displayFingerprint` is its first 16
  hex. These identify the agent to the TRUST system; they are not the routing address.
- **Routing identity**: `IdentityManager` (`src/threadline/client/IdentityManager.ts`) reads
  canonical first, legacy `.instar/threadline/identity.json` second, reports `filesDisagree`
  when both exist and differ, and uses the canonical one. The routing fingerprint is
  `computeFingerprint(pub)` = first 16 bytes of the raw Ed25519 public key as hex. This is what
  the relay registers (`ThreadlineBootstrap.ts:433`), what `/threadline/health` and
  `/provenance` publish, and what peers pin.
- **Join-time carry** (parent spec §1, built): `POST /api/pair` seals the identity to the
  joiner's ephemeral X25519 key with `encryptForSync` (`AgentIdentityHandover.sealIdentityForJoiner`);
  `installAgentIdentityFromPairing` writes it atomically with a `provenance` record and never
  mints on failure.
- **Mint guard** (parent spec §2, built at one of two sites): `getOrCreate()` throws
  `IdentityNotProvisionedError` when `detectJoinedMesh()` sees a sibling.
- **Divergence detector** (parent spec §4, built, wrong formula): delayed boot task in
  `AgentServer.ts`, every machine observes, episode-deduped attention item, `cannot-tell`
  is logged and never pages.
- **Reconciler** (parent spec §3, NOT wired): `decideReconciliation` has no callers.
- **Cross-machine secret sync**: `SecretSync.ts`; X25519 ECDH + HKDF + AES-256-GCM per
  recipient (`SecretStore.encryptForSync/decryptFromSync`); transport `POST /mesh/rpc`
  (Ed25519-signed by the sending machine, bound to the recipient, nonce replay check,
  sender must be a registered active peer); verb `secret-share`, permission class "any
  registered peer". `AccountCredentialShare.ts` establishes the pattern that credential-class
  payloads get their OWN verb rather than riding `secret-share`.
- **Machine-coherence guard**: `MachineCoherenceSentinel` compares `flag | version | manifest |
  protocol` dimensions from the `CoherenceAdvert` each machine publishes in its heartbeat
  (`buildCoherenceAdvert`, pulled by `PeerPresencePuller`), confirms after `flagConfirmTicks`,
  elects one raiser, and raises one item per episode (`machine-coherence:mc-N`). Dev-gated
  dark on the fleet, dry-run on dev.
- **A2A delivery ledger**: `A2ADeliveryTracker` (SQLite), per-message `relay_status`
  (delivered/queued+expires/rejected/expired/unconfirmed), `peerHealth()` with `stale` at 6 h,
  `sweepSilence` promoting expired-queued rows to `unconfirmed`. Relay `delivery_expired`
  frames only reach a sender that is connected at that moment.
- **Standby relay forward** (`a2a-cross-machine-route.md`, built): a standby's A2A send is
  forwarded to the machine holding the relay connection; `deliveryPath: 'forwarded'`.
- **Telegram origin**: `TelegramOriginService` (admit → claim → authorize → execute), durable
  store with recovery schedule (15-min review interval), in-memory held map, 6 h deadline,
  `relayOriginBot` forward-to-holder used only when no bot token is present, MeshRpc verb
  `telegram-origin` on the holder refusing `execution-owner-mismatch`.
- **Lease**: `LeaseCoordinator.holdsLease()` / `currentHolder()`; a standby learns the holder
  from `getSyncStatus().leaseHolder` (`/health → multiMachine.syncStatus`).
- **File routes**: `src/server/fileRoutes.ts` — `NEVER_SERVED_PREFIXES` (code-owned, includes
  `.instar/machine/`, `.instar/secrets/`, `.instar/machines/registry.json`,
  `.instar/config.json`, the identity-store auto-accept protected paths), `blockedFilenames`
  (config-editable via `PATCH /api/files/config`), routes `read`, `download`, `list`, `link`.
- **Migration**: `PostUpdateMigrator.migrate()` (≈75 ordered `migrate*` steps);
  `migrateConfig` merges `ConfigDefaults.getMigrationDefaults()` adding missing keys only;
  `migrateClaudeMd` with content-sniffing guards; dev-gated flags resolve through
  `resolveDevAgentGate(explicit, config)` and must be registered in `DEV_GATED_FEATURES`
  (`scripts/lint-dev-agent-dark-gate.js` enforces it).

## Threat model

- **A hostile or compromised sibling machine requests the agent identity.** Mitigated: the
  share verb is served only to a REGISTERED ACTIVE peer over the signed mesh RPC, only when the
  requester holds NO usable identity (adoption fills a void, never replaces), every share is
  audited on BOTH machines and announced once to the operator. Not mitigated, and stated
  plainly: any machine that is a legitimate sibling already holds the same private key
  (the parent spec's accepted "compatibility bridge" cost). De-pairing rotates the recipient
  key (existing) but does not revoke a copy already held; rotation of the whole agent identity
  remains the only revocation and is out of scope here.
- **A fabricated identity is pushed to a machine with none.** Mitigated: the requester accepts
  an envelope only when its routing fingerprint equals the value EVERY registered sibling
  publishes (unanimity, §1.3), and the envelope's self-signed provenance verifies. One lying
  machine cannot produce unanimity.
- **A stale or wrong "canonical" is auto-written over a working identity.** Not possible by
  construction: nothing in this spec overwrites an EXISTING identity automatically. Replacing
  one is the parent's operator-selection ceremony, now wired (§1.4), with a timestamped backup
  before the rename.
- **A detector that pages on healthy fleets trains the operator to ignore it.** Mitigated by
  §2: one formula, a semantic test that asserts `agree` on identical keys, and a test that
  asserts the sha256 form is never compared to a routing fingerprint.
- **A notice flood when a peer goes dark.** Mitigated: one attention item per (peer, episode),
  resolved on the first ack or inbound, cooldown per peer, dry-run first.
- **The forward-to-holder path becomes an amplifier or a loop.** Mitigated: the holder refuses
  a forward when it is itself standby (existing loop stop), a forwarded operation carries the
  origin operation id so a retry cannot double-send, and the standby never also executes
  locally.
- **Key material leaves via any read surface.** Mitigated by §5: the deny list is code-owned
  and config-immune, checked on the RESOLVED path, applied to `read`, `download` and `list`,
  and ratcheted by a census test that enumerates every private-key-writing site in `src/`.

## Design

### 1. One identity, kept converged — not only carried at join

**1.1 Close the second mint site.** `createUnifiedTrustSystem` gains the same precondition as
`getOrCreate()`: if `.instar/identity.json` is absent AND `detectJoinedMesh(stateDir)` reports a
sibling, it does NOT call `create()`. Instead the server boots in an explicit
`identity-not-provisioned` posture:

- the relay connection is not attempted (there is no identity to connect as) and
  `/threadline/health` reports `relay.state: 'not-provisioned'` with `fingerprint` absent;
- `DegradationReporter.report({feature: 'Threadline.identity', reason: 'joined machine has no
  agent identity', impact: 'not reachable on the agent network until the identity is adopted'})`;
- one HIGH attention item `agent-identity-missing:<agent>:<machineId>`;
- the adoption request (§1.2) is issued immediately and on every presence tick until it
  succeeds or refuses.

A standalone first machine (no registry, or a registry naming only itself) is unaffected and
mints exactly as today. The guard is enforced at BOTH mint sites, by the same
`detectJoinedMesh` function, with a test that fails if a third mint site appears
(`grep` census over `generateIdentityKeyPair\(|identity\.create\(` in `src/`).

**1.2 Post-pairing adoption: a new mesh verb, `agent-identity-share`.** A paired machine that
has no usable identity (absent file, or an unreadable/invalid file that `IdentityManager`
reports as `loadProblem`) asks its siblings for it:

- Requester → each online registered sibling: MeshRpc `agent-identity-request`
  `{agentName, requesterMachineId, requesterEncryptionPublicKey, observedFingerprints}`.
  Signed by the requester's MACHINE key (existing mesh auth), nonce-bound.
- Serving sibling: refuses unless (a) the sender is a registered active peer (existing
  permission class — `secret-share` precedent); (b) the serving machine's own identity is
  usable and its `provenance` is `minted-standalone` or `received-on-join` with a root, OR the
  serving machine is the operator-selected canonical holder per the ceremony record (§1.4);
  (c) rate: at most one share per requester per 10 minutes. On refusal it answers a typed
  reason (`not-registered`, `no-usable-identity`, `unknown-origin-identity`, `rate-limited`).
- Payload: the identity sealed with `encryptForSync` to the requester's long-term machine
  X25519 key (the same primitive and the same key `secret-share` already uses), carrying the
  self-signed provenance record (parent §3) and a new `adoptedFrom: {machineId, at}` field.
- Requester acceptance (§1.3), then `installAgentIdentityFromPairing`'s atomic
  owner-only write (reused), then a NORMAL relay connect on the next tick — no restart.
- Audit: both sides append a row to `logs/agent-identity.jsonl` (`shared-to` / `adopted-from`,
  fingerprint, machine ids, outcome; NEVER key material or the sealed payload). The serving
  side raises ONE NORMAL attention item "I handed my agent identity to <nickname>" — a key copy
  is an event the operator must be able to see.

This is deliberately a separate verb from `secret-share`: the identity is credential-class
(cf. `AccountCredentialShare`), it must never ride the general secret set, and its
permission check must say "requester has no identity" — a predicate `secret-share` cannot
express.

**1.3 Which identity to adopt: unanimity of ALL registered siblings, or refuse.** A machine
with no identity adopts an identity only when:

- every machine in `.instar/machines/registry.json` other than itself was reached in this
  round and published a routing fingerprint (`/provenance` over the mesh); and
- all published fingerprints are identical; and
- the sealed envelope's public key hashes (routing formula) to exactly that value; and
- the provenance record verifies against that key.

Any unreachable sibling, any disagreement, any verification failure → refuse, stay
`identity-not-provisioned`, keep the attention item open with the observed set named. The
parent spec rejected peer MAJORITY as authority for choosing BETWEEN candidates; this rule is
narrower and different in kind — it fills a void with the single value the whole fleet
already agrees on, and refuses whenever the fleet does not. It cannot pick a wrong identity
unless every sibling is wrong at once, which is the state the operator ceremony (§1.4) exists
for and which this rule explicitly refuses to touch.

**1.4 Wire the operator-selection ceremony.** `decideReconciliation` becomes reachable:
`POST /agent-identity/reconcile/plan` (Bearer) renders the candidate set in the parent's
human terms ("the identity your Mini, Laptop and Mama PC have used since May" vs "the one the
Studio created for itself on 26 August"), and `POST /agent-identity/reconcile/commit`
(dashboard PIN + the plan id; one plan, single-use) replaces the identity on the named
machine(s) through the sealed share path, with the superseded file backed up as
`identity.json.superseded-<ISO>` before the rename. The commit record (candidate set, chosen
fingerprint, operator, time) is written and replicated. No other path ever rewrites an existing
identity. The dashboard Machines tab carries the plan/commit surface (Mobile-Complete Operator
Actions); the routes are how the agent reads and renders, never something the operator curls.

**1.5 The legacy file is a mirror, repaired on read.** When `IdentityManager.loadFromDisk()`
finds both files and they disagree, the canonical one wins (as today) AND the legacy file is
rewritten to match — by the single writer the `threadline-identity-single-writer` spec
designates, atomically, with a timestamped backup of the old legacy file — and ONE degradation
row says so. Today's manual fix left exactly this state and the server logs an `[identity]`
ERROR at every boot; a mirror that disagrees is noise with no decision behind it.

**1.6 Set the join-time pin.** `instar pair` prints the agent's routing fingerprint beside the
code, and the pairing artefact embeds it; `instar join` accepts `--agent-fingerprint` and
reads it from the artefact when present. With the pin set, the envelope check in
`installAgentIdentityFromPairing` is no longer the degenerate self-pin. The pin uses the
routing formula (§2.1).

**1.7 Join-time fallback.** When a join completes without an identity envelope (old awake
machine), the joiner no longer stops at "update it and re-pair": it boots in
`identity-not-provisioned` posture and runs §1.2–1.3 against the full sibling set, which
succeeds the moment any updated sibling is online and the fleet is unanimous.

### 2. Loud cross-machine mismatch: one formula, one episode, one item

**2.1 One comparison value.** The routing fingerprint (`computeFingerprint`, raw public-key
prefix) is the ONLY value ever compared across machines or against a peer's pin.
`AgentIdentityHandover.fingerprintOf` is changed to it; `canonicalId`/`displayFingerprint`
stay what they are (trust-system identifiers) and are never placed in a routing comparison.
The detector reads its own value through `IdentityManager.get()` — the same resolver the relay
connects with — not through a private file read with a private formula (Verify the State, Not
Its Symbol).

**2.2 The fleet floor: the boot detector, fixed and continuous.** The existing boot task stays
(always on, every machine, no flag — a dark identity check checks nothing) with three changes:
the formula fix; it re-runs on every presence tick (30 s) rather than once at boot, so a split
that appears after boot is seen; and its attention item id becomes
`agent-identity-split:<agent>:<sorted fingerprint set>`. `cannot-tell` remains visible and
never pages. The item resolves itself when a later round reads `agree`.

**2.3 The coherence dimension.** `CoherenceAdvert` gains `agentFingerprint` (32 hex,
validated by a hex regex in `clampCoherenceAdvert`; an older peer without the field is
`compared` on the other dimensions and `unknown` on this one — never `advert-rejected`).
`SkewDimension` gains `identity`. An `identity` row is ALWAYS loud (HIGH, never calm), is NOT
suppressed by version skew (an identity split is independent of the version that produced
it), confirms after `flagConfirmTicks`, and is worded by `guaranteeFor('identity')`: "my
machines are not the same me on the agent network — <nick> publishes X, the others publish
Y; messages addressed to Y are lost while <nick> holds the relay". When the guard raises an
identity row it uses the SAME item id as §2.2, so the two observers can never produce two
items (`createAttentionItem` is idempotent on id). The guard rides its own existing gate
(`monitoring.machineCoherence`), so on the fleet §2.2 alone speaks; on dev both agree.

**2.4 The holder's own check.** The machine that holds the relay connection additionally
compares the fingerprint it CONNECTED as (`relayClient.fingerprint`) against the §2.2 verdict
each tick. If it is connected as a fingerprint its siblings do not publish, the item body
gains the line "this machine holds the relay under an address no sibling uses — peers cannot
reach the agent", and `/threadline/health` reports `identityCoherence: {state: 'disagree',
connectedAs, siblingsPublish}`.

### 3. Honest sender-side reporting of a send that stays queued

**3.1 Classification.** `A2ADeliveryTracker.peerHealth()` gains `dark` and `darkSince`: a peer
is `dark` when its oldest row in `awaiting-ack` with `relay_status` `queued` (or no verdict)
is older than `queuedDarkAfterMs` (default 2 h) AND no ack and no inbound from that peer has
arrived since that row was sent. A peer stops being dark on the first ack, inbound, or
`delivered` verdict. `stale` (6 h) is unchanged and remains the ACK-discipline field.

**3.2 Where it is said.**

- **In the send response.** `POST /threadline/relay-send` (and `threadline_send`) answers a
  send to a dark peer with `peerDark: {since, queuedCount, expiresAt}` and a `deliveryOutcome`
  sentence: "<peer> has not been reachable on the relay for N h; this and K other messages are
  queued and the oldest expires at T. Nothing will arrive until <peer> connects." When the
  relay's `discover` result lists the peer, the sentence adds "last seen on the relay at T";
  when it does not, it adds "the relay does not list this address" — stated as unknown, never
  as "has never connected", because the registry lists only agents that chose to be listed.
- **On the health read.** `GET /threadline/peers/health` and the per-peer route carry `dark`,
  `darkSince`, `queuedCount`; pool scope merges as today.
- **To the operator, once.** When a peer crosses into `dark` while at least one message is
  queued, ONE NORMAL attention item `a2a-peer-dark:<peerFp>:<episode>` is raised: "Messages
  to <peer> are stuck: K queued since T, none delivered. <peer> may be offline, or may be
  listening under a different address (the fault I had on the Studio until 9 Oct)." It is
  resolved automatically when the peer leaves `dark`; a new episode needs a new crossing; per
  peer cooldown 12 h. The wording names the identity-split possibility explicitly because it
  is the one cause the sender can do something about (ask the peer to check its fleet).

**3.3 Separation from redelivery.** `A2ARedeliverySentinel` stays as it is (off by default,
resend + escalate). §3 never resends. A message that expires is already promoted to
`unconfirmed` by `sweepSilence`; the dark notice is the plain-English face of that ledger.

**3.4 Rollout.** `threadline.peerDarkNotice: {enabled (dev-gated), dryRun: true,
queuedDarkAfterMs: 7200000, cooldownMs: 43200000}`. Dry-run logs would-raise rows to
`logs/a2a-peer-dark.jsonl`; the send-response and health fields are live from the first build
(they are reads). Registered in `DEV_GATED_FEATURES`.

### 4. ACT-058 — a reply held on a non-lease machine is moved, and if it cannot be moved, reported

**4.1 Forward before hold.** `TelegramAdapter.willRelay()` becomes "no usable bot token OR
(session pool enabled AND this machine does not hold the lease)". A standby that owns a topic
therefore sends its reply through `relayOriginBot` to the lease holder — preparing the
operation with `executionOwnerMachineId = holder` so the holder's `execution-owner-mismatch`
check passes — exactly the path a token-less machine already takes. The holder runs the
ordinary origin route (authorize passes there), records the origin with
`deliveryMachineId = holder` and `forwardedFromMachine = standby`, and the reply lands in the
topic with its normal origin footer. The standby never also executes locally.

**4.2 When the forward fails, hold durably and say so.** If the holder is unreachable, refuses,
or the lease is unresolved (`leaseHolder: null`), the operation is held with durable state
`held` (new: `recordOperationState('held', reason)`, so a restart cannot forget it; the
in-memory map becomes a cache of the store, not the source of truth). The recovery tick on
the standby re-attempts the FORWARD (never the local authorize, which can only re-hold), on
the existing 15-min schedule and 6 h deadline. The `onHold` callback admits
`destination-not-authorized`, and the notice policy's `ownershipValid` is satisfied by
"the holder will send it" rather than by `holdsLease()`: the standby asks the HOLDER to post
the fixed outage template ("I have your message; my reply is delayed while it is routed through
<holder nickname>") through the same forward path. If the holder cannot be reached for the
notice either, the hold is still never silent: `/health` carries a `telegramOrigin.heldForward`
degradation, `/telegram/origins/status` lists it under `held` with reason
`forward-to-holder-failed`, and ONE HIGH attention item names the topic and the holder.

**4.3 Expiry is a reported outcome.** A held operation that reaches its deadline is recorded as
`expired-unresolved` in the DURABLE store (today it is memory-only), and the expiry raises the
same per-topic item ("I could not deliver my reply to <topic> within 6 h"), so an undelivered
reply is always traceable from the origin audit.

**4.4 Named dependency, not claimed.** ACT-058 also records an ownership-registry divergence
(the holder's registry names an owner that has no record of owning the topic, so
`/pool/transfer` degrades to `refused-not-owner` and the pin never actuates). That is a pool
ownership defect under the WS1.3 reconciler and is tracked separately; §4 makes a standby-owned
topic ANSWERABLE regardless of whether the ownership record is coherent.

**4.5 Rollout.** `telegram.originForwardToHolder: {enabled: true, dryRun: false}` with an
explicit off-switch. Reachability is a safety floor the constitution forbids dark-shipping
("The Agent Is Always Reachable", corollary 2 — no silent resource rejection); it ships ON,
soaked 48 h on the dev agent in `dryRun: true` (logs the would-forward, still holds) before the
flip. Single-machine agents are a strict no-op (`holdsLease()` is always true).

### 5. Key material is never served, by a list the config cannot loosen

**5.1 Extend the code-owned deny list.** `NEVER_SERVED_PREFIXES` gains: `.instar/identity.json`,
`.instar/identity.json.` (backups), `.instar/threadline/` (identity, inbox HMAC key,
invitation secret, secure invitations — the whole directory; conversation and trust files
there are agent-internal state, not operator documents), `.instar/machine-ssh/`,
`.instar/state/inbound-delivery.hmac-key`, `.instar/relay-tokens.json`, `.instar/local-state/`,
`.instar/origin-sessions-`, `.instar/state/conversation-bind-token.secret`. The list stays
config-immune: `PATCH /api/files/config` can narrow `allowedPaths` and extend `blockedFilenames`
but can never remove a never-served entry.

**5.2 Check the resolved path, everywhere.** `checkBlockedFilename` and the never-served
check run on BOTH the requested path and the `realpath`-resolved one, in `read`, `download`
AND `list` (today `list` filters only by `blockedFilenames`, so never-served names still
appear). Glob entries `*.hmac-key` and `*-ed25519-g*` join `blockedFilenames` as DEFAULTS and
are mirrored into the code-owned list so a config edit cannot drop them.

**5.3 The ratchet.** A unit test (`tests/unit/file-routes-key-census.test.ts`) greps `src/`
for every site that writes private-key or secret material (`privateKey`, `-key.pem`,
`hmac-key`, `secrets-master.key`, `relay-tokens`, `keys.enc`, `*.secret`) and asserts the
written path is refused by `isNeverServed` or `checkBlockedFilename` on the resolved path. A
new key-writing site that is not denied fails CI. This is the Structure > Willpower arm: the
list cannot silently fall behind the code that mints keys.

**5.4 No flag.** This is a security floor; it ships live with no config and no migration
(the list is code). A one-line release note says what became unreadable through the Files
tab.

## Decision points touched

- **New refusal**: `createUnifiedTrustSystem` refuses to mint on a joined machine (boots
  `identity-not-provisioned` instead of inventing an identity).
- **New refusal**: `agent-identity-share` refuses `not-registered`, `no-usable-identity`,
  `unknown-origin-identity`, `rate-limited`; adoption refuses on any non-unanimity.
- **New PIN gate**: `POST /agent-identity/reconcile/commit` (dashboard PIN; a Bearer token
  cannot replace an existing identity).
- **Changed routing**: a standby's Telegram origin send is forwarded to the lease holder
  instead of being authorized locally; the local hold becomes the fallback, durable and
  reported.
- **Changed classification**: the identity-divergence detector's verdict (now computed on one
  formula); new `identity` skew dimension (always loud).
- **New signal**: per-peer `dark` and the `a2a-peer-dark` attention item (signal-only).
- **New denial**: file routes refuse identity/key/secret paths on the resolved path, in
  `read`/`download`/`list`, config-immune.

Nothing here grants authority: a shared identity is a routing key, not a permission; a
forwarded reply is still subject to the holder's full outbound gate; an adopted identity
does not establish an operator.

## Multi-machine posture

- §1 runs on every machine; the serving side of adoption is any usable sibling; the
  requester is the identity-less one. Single-machine: strict no-op (no registry sibling →
  mint as today).
- §2 every machine observes; one item id across all observers; the guard's raiser election is
  unchanged.
- §3 the ledger lives on the machine that sent (the relay holder, or the forwarder's holder
  for forwarded sends); pool scope merges rows as today.
- §4 the standby forwards; the holder executes; a holder that is itself standby refuses
  (existing loop stop). The 409 `write-refused`/standing-down semantics are untouched.
- §5 per machine, code-owned.
- Every heartbeat/advert addition is tolerant of an older peer (field absent → `unknown`,
  never rejected), so a rolling update does not itself raise an identity row.

## Frontloaded Decisions

1. **One comparison formula — the routing fingerprint (raw public-key prefix) — everywhere an
   agent identity is compared.** The sha256-based `canonicalId` is a trust-system id and is
   never compared to a routing value. NOT cheap: it changes what the detector claims and what
   the pin verifies; it is the correction of a measured false alarm.
2. **Both mint sites are guarded by the same `detectJoinedMesh` predicate, and a joined
   machine with no identity boots unprovisioned rather than minting.** NOT cheap (identity).
   A standalone first machine is unaffected by an on-disk fact, not a guess.
3. **Adoption fills a void and never replaces.** No automatic path overwrites an existing
   identity; replacement is the PIN-gated operator ceremony with a backup before rename. NOT
   cheap (identity; a wrong rewrite takes the agent off the network).
4. **Adoption requires unanimity of ALL registered siblings, reached in the same round.** Any
   gap refuses. NOT cheap (identity). Rationale above (§1.3).
5. **The identity rides a dedicated mesh verb (`agent-identity-share`), sealed with the
   existing `encryptForSync` to the requester's machine X25519 key, audited on both sides and
   announced once.** NOT cheap (key custody). Reusing `secret-share` was rejected: it cannot
   express "only when the requester has no identity" and it would put the agent key in the
   general sync set.
6. **The legacy `threadline/identity.json` is a mirror repaired on read, with backup.** Tagged
   cheap-to-change-after: it is a derived file the server already ignores when it disagrees;
   the backup makes the repair reversible; the single-writer spec owns the write.
7. **The identity dimension is always loud and never suppressed by version skew.** NOT cheap
   (user-visible alert semantics) — but it is the parent spec's stated intent ("notice the
   split at all") finally made true.
8. **Dark-peer reporting is signal-only, separate from redelivery, deduped per (peer,
   episode), dev-gated + dry-run first.** Cheap-to-change-after: pure reads plus a dry-run
   logged notice; the thresholds are config.
9. **A standby forwards its origin sends to the lease holder before `authorize` can hold
   them; a failed forward is a DURABLE hold with a notice through the holder, a `/health`
   degradation and one attention item.** NOT cheap (user-visible reachability); ships ON after a
   48-h dev dry-run because the constitution forbids dark-shipping reachability.
10. **Key material is denied by a code-owned, config-immune list checked on the resolved
    path in every file route, ratcheted by a key-census test.** NOT cheap (security surface);
    no flag.
11. **No relay-side retirement of the orphan `afd256bc…` / `ae6feac6…` rows.** Still the
    parent's Frontloaded Decision 5 / CMT-026: a relay operation needing its own authorization
    model. Named, not claimed.
12. **No per-device certificates / account-identity migration.** The shared-key bridge stays;
    the parent spec's recorded cost and the "rotation is the only revocation" notice on machine
    removal are unchanged.

## Tests (Testing Integrity Standard — all three tiers, each section)

**Tier 1 — unit (`tests/unit/`)**
- `agent-identity-mint-guard.test.ts`: both mint sites refuse with a sibling in the registry;
  both mint with none; a corrupt registry resolves toward minting; a `grep` census over `src/`
  finds exactly two `generateIdentityKeyPair`/`identity.create` sites and both are guarded.
- `agent-identity-fingerprint-formula.test.ts`: `fingerprintOf(pub) === computeFingerprint(pub)
  === /provenance fingerprint === /threadline/health fingerprint` for the same key; the sha256
  form never equals any of them; the detector returns `agree` for four machines holding the
  same key and `disagree` for the 63b1/afd2 pair — both sides of the boundary with real keys.
- `agent-identity-adoption.test.ts`: unanimity → adopt; one unreachable → refuse; one
  disagreeing → refuse; envelope key not hashing to the unanimous value → refuse; bad provenance
  signature → refuse; serving side refuses a requester that HAS an identity, an unregistered
  sender, an `unknown-origin` self; rate limit; audit rows contain fingerprints and never key
  bytes (byte-scan of the log).
- `agent-identity-legacy-mirror.test.ts`: disagreeing legacy file is rewritten from canonical
  with a backup; agreeing files untouched; a write failure leaves the old file and reports.
- `machine-coherence-identity-dimension.test.ts`: advert with/without the field; `identity`
  row is HIGH, not calm, survives version skew, confirms after N ticks, uses the shared item id;
  an invalid hex value → `unknown`, not `advert-rejected`.
- `a2a-peer-dark.test.ts`: dark after 2 h queued with no inbound; not dark with an inbound
  after the oldest send; clears on ack; one item per episode; cooldown; dry-run writes the
  would-raise row and no item; `deliveryOutcome` wording for listed vs unlisted peer.
- `telegram-origin-forward-on-standby.test.ts`: `willRelay()` true on standby with token;
  forwarded op carries `executionOwnerMachineId = holder`; holder-standby refuses; failed
  forward → durable `held` state survives a service restart; recovery re-forwards, never
  re-authorizes locally; deadline → durable `expired-unresolved`; `onHold` admits
  `destination-not-authorized`; the notice goes through the holder; single-machine no-op.
- `file-routes-never-served.test.ts`: every added prefix/glob refused on `read`, `download`,
  `list` for the direct path, a symlink with an innocent name, and a case-folded path;
  `PATCH /api/files/config` cannot remove them; allowed sibling files still serve.
- `file-routes-key-census.test.ts` (the ratchet, §5.3).

**Tier 2 — integration (`tests/integration/`)**
- Two in-process servers paired via the real `/mesh/rpc`: B boots with no identity and a
  registry naming A → B stays unprovisioned, requests, adopts, connects to a stub relay as A's
  fingerprint; a third stub peer publishing a different fingerprint → B refuses and the item
  names both values.
- `POST /agent-identity/reconcile/plan` renders two candidates; `commit` without PIN → 401;
  with PIN replaces the named machine's identity and leaves a `superseded-<ISO>` backup.
- Stub relay answering `queued` with a TTL: after the dark threshold the send route carries
  `peerDark`, `/threadline/peers/health` shows `dark`, one attention item exists; an inbound
  from the peer resolves it.
- Standby + holder pair with a Telegram stub: the standby's `/telegram/reply` lands via the
  holder with `forwardedFromMachine`; holder down → 409 `telegram-origin-held` with
  `reason: forward-to-holder-failed`, `/telegram/origins/status.held[]` lists it, `/health`
  carries the degradation; holder back → recovery delivers it once.
- File routes against a fixture agent home containing every key file from the census: all
  refused; `list` omits them.

**Tier 3 — E2E lifecycle (`tests/e2e/`)**
- The production init path (mirroring `server.ts`): the routes exist and answer 200/409 (never
  503) — `/agent-identity/reconcile/plan`, `/threadline/peers/health` with the new fields,
  `/pool/machine-coherence` with the `identity` dimension when the guard is on; the boot
  detector runs on a presence tick and `/threadline/health.identityCoherence` is populated;
  wiring-integrity: the forward dependency, the share handler, the dark classifier and the
  never-served list are real implementations, not null or no-ops.
- Migration E2E: an existing agent config gains the new defaults, the CLAUDE.md template
  sections land once and are idempotent on a second run.

Live proof (Live-User-Channel Proof Before Done): before "done", a throwaway two-agent-home
pair on this Studio exercises adoption, the false-alarm regression (identical keys →
`agree`), a forwarded Telegram reply into a proof room, and a Files-tab download attempt of
`.instar/identity.json` (expect 403) — recorded as the signed scenario matrix.

## Migration parity

- **Config defaults** (`ConfigDefaults.ts` → `migrateConfig` adds missing keys only):
  `threadline.peerDarkNotice {dryRun:true, queuedDarkAfterMs, cooldownMs}` (no `enabled` key —
  dev-gate resolution), `telegram.originForwardToHolder {enabled:true, dryRun:false}`,
  `agentIdentity.adoption {enabled:true}` (the kill switch for §1.2; §1.1's refusal has no
  switch — a joined machine minting is never correct).
- **CLAUDE.md template** (`generateClaudeMd()` + `migrateClaudeMd` with content-sniff guards):
  the "Agent awareness" bullets below.
- **Hooks / skills**: none.
- **Never-served list**: code; no migration. **Dev-gate registry**: `threadline.peerDarkNotice`
  added to `DEV_GATED_FEATURES` (lint-enforced).
- **One-time boot repair**: §1.5's mirror repair and §2.2's detector run at boot on every
  updated machine, so an agent already in today's "two disagreeing files" state heals on
  update without an explicit migration step.
- **Idempotency**: every step above checks before writing; the E2E migration test runs twice.

## Rollback

- §1.1 guard: reverting re-opens silent minting on joined machines (the parent's rollback
  note applies: pair a revert with a freeze on joins or hand-provision). Adoption (§1.2–1.3)
  has a kill switch; with it off a joined identity-less machine stays unprovisioned and loud,
  which is strictly better than minting.
- §2: reverting the formula restores the false alarm; reverting the dimension removes a row,
  never a guarantee that existed before.
- §3: flag off → reads still populated, no notice (today's behaviour).
- §4: `originForwardToHolder.enabled:false` → today's local hold, now durable and reported (the
  durable `held` state and the notice are not behind the flag — a silent hold is the defect).
- §5: no rollback lever by design; a false positive (an operator document under a denied
  prefix) is fixed by moving the document, not by serving keys.
- Nothing here deletes an identity file: superseded files are backed up beside the new one.

## Agent awareness (CLAUDE.md template additions)

- **One identity across my machines**: a machine that joins or is rebuilt ADOPTS the agent
  identity from its siblings; it never invents one. If a machine reports
  `identity-not-provisioned`, read `GET /threadline/health` (`relay.state`,
  `identityCoherence`) and the `agent-identity-missing` attention item; adoption refuses unless
  every sibling agrees — say which sibling was unreachable or disagreed, never guess. Replacing
  an EXISTING identity is the operator's PIN ceremony on the Machines tab, never a file copy.
- **"Are my machines the same me on the agent network?"** → `GET /pool/machine-coherence`
  (identity row) or `GET /threadline/health.identityCoherence`. A split means peers' messages
  to me are being queued and lost; the item names the machine holding the relay under the
  wrong address.
- **"Did <peer> get my message?"** → the send response's `relayStatus` AND `peerDark`; a dark
  peer has had messages queued for hours with nothing delivered — it may be offline or
  listening under a different address. `GET /threadline/peers/health` → `dark`, `darkSince`,
  `queuedCount`.
- **"Why was my reply delayed / why did a topic go quiet on my other machine?"** → on a
  machine that does not hold the lease, replies are forwarded to the holder; a failed forward
  is a durable hold listed in `GET /telegram/origins/status` (`held[].reason:
  forward-to-holder-failed`) with one attention item — never a silent drop.
- **Files tab**: identity, machine, SSH and HMAC key files are never served or listed; a 403
  on one of these is correct, not a bug to route around.

## Observability

- `logs/agent-identity.jsonl`: mint-refused (site, sibling count), adoption
  requested/served/refused (typed reason, fingerprint set), mirror-repaired, reconcile
  plan/commit, detector verdict transitions (agree/disagree/cannot-tell with per-peer reason).
  Fingerprints only; never key bytes or sealed payloads (byte-scan test).
- `GET /threadline/health`: `identityCoherence`, `relay.state: 'not-provisioned'`.
- `GET /threadline/peers/health`: `dark`, `darkSince`, `queuedCount`; `logs/a2a-peer-dark.jsonl`.
- `GET /telegram/origins/status`: durable `held` with `forward-to-holder-failed`, durable
  `expiredHolds`; `/health → telegramOrigin.heldForward` degradation.
- `GET /pool/machine-coherence`: the `identity` dimension and its episode.
- Attention item ids: `agent-identity-missing:…`, `agent-identity-split:…`,
  `agent-identity-shared:…`, `a2a-peer-dark:…`, `telegram-origin-held:<topic>`.

## Out of scope

- Relay-side retirement of orphan registrations (CMT-026).
- Rotation of the agent identity across the fleet; per-device certificates.
- The pool ownership-record divergence named in ACT-058 (WS1.3 reconciler).
- Encrypting the canonical private key at rest by default (the boot path passes no
  passphrase; a change there needs its own operator ceremony and is a separate spec).
- Teaching the relay to answer "never registered" (a relay protocol change; §3 reports
  honestly without it).

## Open questions

1. `.instar/threadline/` as a whole becomes never-served. Does any operator workflow read
   `conversations.json` or `trust-profiles.json` through the Files tab? If so, deny only the
   key files (`identity.json`, `inbox-hmac.key`, `invitation-secret.key`,
   `secure-invitations.json`) instead of the directory.
2. The dark threshold default (2 h) is below the 6 h stale/ACK window on purpose, so a sender
   is told before the ACK discipline would escalate. Is 2 h the right default for Dawn-scale
   traffic, or should it track the relay's TTL (24 h ÷ 12)?

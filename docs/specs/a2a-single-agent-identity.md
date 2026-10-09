---
title: "A2A single agent identity — one identity across all machines, kept converged, loudly checked, honestly reported"
slug: "a2a-single-agent-identity"
author: "echo"
status: "draft"
origin: "CMT-706 (Justin, Telegram topic 9210, 2026-10-09): 'Find a robust solution so agent identity mismatches are NEVER an issue for agent-to-agent communication.' Incident 2026-10-08 / ACT-058."
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "Verify the State, Not Its Symbol; No Silent Degradation; The Agent Is Always Reachable; Know Your Principal — An Unverified Identity Is a Guess; Structure > Willpower; Close the Loop; Self-Heal Before Notify; Bounded Notification Surface"
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

Each of these is a measured fact about the tree at branch base `e76caca6a` (v1.3.1334; the
spec's worktree is `a2a-single-identity` on that base), not an inference:

1. **The guard protects the wrong mint site.** The parent's §2 guard lives in the Threadline
   client's `getOrCreate()` (`src/threadline/client/IdentityManager.ts:88-118`) and refuses to
   mint when `detectJoinedMesh()` finds a sibling in the machine registry. But the server boots
   the unified trust system FIRST, and `createUnifiedTrustSystem`
   (`src/threadline/UnifiedTrustWiring.ts:86-105`) calls `CanonicalIdentityManager.create()`
   whenever `.instar/identity.json` is absent and no legacy file exists — with no join check at
   all. The canonical file then exists, the guarded `getOrCreate()` finds it, and the guard
   never fires. On a joined machine whose join-time handover did not land (or whose agent
   home was rebuilt), this mints a second identity at boot every time.
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
   broken states is not a detector; it was ignored for exactly that reason. The existing unit
   test (`tests/unit/agent-identity-divergence.test.ts`) feeds opaque string fixtures, so the
   mismatch was structurally untestable there. The detector also runs ONCE, 90 s after boot.
4. **The join-time pin is never set.** The parent's §1 has the joiner pin the agent fingerprint
   before accepting an envelope. `JoinOptions.agentFingerprint` (`src/commands/machine.ts:424`)
   is never populated: `instar join` (`src/cli.ts:2164-2170`) has no such option. The pin
   falls back to the envelope's own fingerprint, which pins nothing.
5. **The relay's `queued` is indistinguishable from "nobody will ever receive this".** The relay
   queues for any fingerprint not currently connected (`RelayServer.ts:1060-1080`,
   `OfflineQueue.enqueue`), never consults its registry, and tells the sender only a TTL.
   The sender's own ledger (`A2ADeliveryTracker`) marks a peer `stale` after 6 h, but that is a
   read-only field on `GET /threadline/peers/health`. The one component that could speak — the
   `A2ARedeliverySentinel` (escalate-once per peer, ONE aggregated item, with an
   escalate-only mode when `redeliver` is omitted) — ships `enabled: false`, and its trigger
   is attempt exhaustion at 6 h+, not "queued for hours with nothing delivered".
6. **A reply from a machine that does not hold the lease is held forever, silently.** With the
   session pool on, a topic is legitimately owned by a standby machine. Its replies go
   through `TelegramOriginService`, whose `authorize` requires `holdsLease()`
   (`TelegramOriginBoot.ts:139`). The hold (`#hold`, reason `destination-not-authorized` — the
   same reason a foreign-chat refusal gets) keeps the payload in a per-process map, never calls
   the store's existing `recordOperationState('held')` (the durable state stays `admitted`), is
   excluded from the outage-notice callback (`TelegramOriginRuntime.ts:128-143`), and is
   retried every 15 min by a recovery tick that is not lease-gated — so a standby re-holds its
   own message nine times and then drops it from memory. The forward-to-holder primitive
   (`telegram.outboundRelay` → `relayOriginBot`, `OriginMeshRelay.ts`) exists but the send
   decision in `TelegramAdapter.sendToTopic` (`:1392`, mirrored by `willRelay()` at `:663`)
   takes it only when the adapter has NO bot token; a standby that has the token takes the
   direct path and is held. This is ACT-058 (observed 2026-10-08 on topic 122413: two operator
   messages unanswered, no notice).
7. **The Files tab hands out private keys.** `GET /api/files/download` (`fileRoutes.ts:859-907`)
   streams any file under the project dir that passes the config-immune `NEVER_SERVED_PREFIXES`
   and the config-editable `blockedFilenames`. Neither covers `.instar/identity.json` (the
   canonical Ed25519 private key, stored in plaintext because the boot path passes no
   passphrase) or `.instar/threadline/identity.json` (the legacy private key). Also uncovered:
   `.instar/machine-ssh/*-ed25519-g*` (SSH private keys), `.instar/state/inbound-delivery.hmac-key`,
   `.instar/relay-tokens.json`, `.instar/local-state/keys.enc`. The basename check runs on the
   REQUESTED name, not the resolved one, so a symlink defeats `*.key`. Any Bearer holder —
   every session, every script, every dashboard PIN exchange — can download the agent's
   signing identity. The same two files are also absent from the gitignore entries, the
   secret-pattern classifier (`FileClassifier` matches `.instar/identity.json` exactly, so a
   backup sibling is unclassified) and the backup never-list.

### Parent acceptance criteria, re-verified at `e76caca6a`

The parent carries `review-iterations: 7`, `approved: true` and a cross-model review, and
shipped with its own acceptance criteria unmet in code. A converged spec is not a met one; this
table is the loop-closer, and §Tests binds every criterion of THIS spec to a named test so the
same gap cannot recur here.

| Parent AC | State at `e76caca6a` | Closed by |
|---|---|---|
| AC1 — joiner publishes the same fingerprint as the machine it joined, verified against the live published value | unmet: the detector reads a file with a private formula | §2.1, §2.2 |
| AC2 — `getOrCreate()` refuses to mint when join state is present | met at that site; the canonical site is unguarded | §1.1 |
| AC3 — a missing/malformed envelope fails loudly and provisions nothing | met at join time; no post-join path exists | §1.2, §1.7 |
| AC6 — the reconcile migration repairs a confirmed split via the sealed path | unmet: `decideReconciliation` has no callers | §1.4 |
| AC7 — the divergence detector reports `disagree` only on a real split | unmet: the formula mismatch makes every fleet read `disagree` | §2.1, §2.2 |
| AC7b — an operator-selection surface exists | unmet | §1.4 |
| AC7c — version-skew fallback | left as "update and re-pair" | §1.7 |

### The shape of the failure

Every item above is the same defect at a different layer: a symbol was trusted in place of
the state it stands for (the guard assumed one mint site; the detector assumed one formula;
"queued" was read as "will arrive"; `admitted` was read as "will be sent"; "allowed path" was
read as "safe to serve"; "converged" was read as "met"). The fix is therefore not one patch
but a set of structural guarantees, each verified against live state and each with a test
that fails when the guarantee is absent.

## What exists (verified at `e76caca6a`)

- **Canonical identity**: `CanonicalIdentityManager` (`src/identity/IdentityManager.ts`),
  file `.instar/identity.json` = `{version, publicKey, privateKey, privateKeyEncryption,
  keySalt?, canonicalId, displayFingerprint, createdAt, …}`, written through the single
  owner-only writer `src/identity/IdentityKeyFile.ts` (`writeFileAtomicOwnerOnly`,
  `createFileExclusiveOwnerOnly`). `canonicalId` is `sha256("instar-agent-id-v1" ‖ pub)`;
  `displayFingerprint` is its first 16 hex. These identify the agent to the TRUST system; they
  are not the routing address.
- **Routing identity**: `IdentityManager` (`src/threadline/client/IdentityManager.ts`) reads
  canonical first, legacy `.instar/threadline/identity.json` second, reports `filesDisagree`
  when both exist and differ, and uses the canonical one. `get()` returns a CACHED identity
  after the first load. The routing fingerprint is `computeFingerprint(pub)` = first 16 bytes
  of the raw Ed25519 public key as hex. This is what the relay registers
  (`ThreadlineBootstrap.ts:433`), what `/threadline/health` and `/provenance` publish, and
  what peers pin. The listener daemon (`src/threadline/listener-daemon.ts:135`) loads ITS
  identity from the legacy path as its primary key file.
- **Join-time carry** (parent spec §1, built): `POST /api/pair` seals the identity to the
  joiner's ephemeral X25519 key with `encryptForSync` (`AgentIdentityHandover.sealIdentityForJoiner`);
  the envelope's `identityFingerprint` and each provenance record's `rootFingerprint` are
  written in the sha256 form; `installAgentIdentityFromPairing` writes atomically and never
  mints on failure. The provenance record carries NO signature field (the parent's
  "self-signed" record is unbuilt).
- **Mint guard** (parent spec §2, built at one of two sites): `getOrCreate()` throws
  `IdentityNotProvisionedError` when `detectJoinedMesh()` sees a sibling; `detectJoinedMesh`
  counts every registry row regardless of `status` (revoked rows count as "joined" — the safe
  direction for a MINT guard).
- **Divergence detector** (parent spec §4, built, wrong formula): one-shot boot task in
  `AgentServer.ts`, every machine observes via Bearer `fetch(<peerUrl>/provenance)` (8 s
  timeout), episode-deduped attention item, `cannot-tell` logged and never pages.
- **Reconciler** (parent spec §3, NOT wired): `decideReconciliation` has no callers.
- **Cross-machine secret sync**: `SecretSync.ts`; X25519 ECDH + HKDF + AES-256-GCM per
  recipient (`SecretStore.encryptForSync/decryptFromSync`) sealed to the RECIPIENT'S REGISTRY
  `encryptionPublicKey`; transport `POST /mesh/rpc` (requests Ed25519-signed by the sending
  machine, bound to the recipient, nonce replay check, sender must be a registered active
  peer; RESPONSES are not signed; the tailscale/LAN ropes advertise `http://`). Verb
  `secret-share`, permission class "any registered peer". `AccountCredentialShare.ts`
  establishes the pattern that credential-class payloads get their OWN verb.
- **Machine registry**: `.instar/machines/registry.json` rows carry `status`
  (`active|revoked|pending`) and `revokedAt`; `removeMachine` sets `revoked`, it does not
  delete; `isRegistryEntryActive(entry)` (`MachineIdentity.ts:147`) is the predicate.
- **Machine-coherence guard**: `MachineCoherenceSentinel` compares `flag | version | manifest |
  protocol` dimensions from the `CoherenceAdvert` each machine publishes in its heartbeat
  (`buildCoherenceAdvert`, pulled by `PeerPresencePuller` every 30 s over the mesh
  `session-status` verb and stored in the presence registry), confirms after
  `flagConfirmTicks`, elects one raiser, and raises one item per episode. Advert measured at
  1354 B of the 2048 B `MC_FLAGS_BYTES_MAX`; `clampCoherenceAdvert` rebuilds the advert from a
  field whitelist. Dev-gated dark on the fleet, dry-run on dev.
- **A2A delivery ledger**: `A2ADeliveryTracker` (SQLite, no retention), per-message
  `relay_status` (delivered/queued+expires/rejected/expired/unconfirmed), `peerHealth()` with
  `stale` at 6 h (using an `expiredNewer` rule: an expired row newer than the last ack/inbound
  keeps the peer stale), `sweepSilence` promoting expired-queued rows to `unconfirmed`. Relay
  `delivery_expired` frames only reach a sender that is connected at that moment.
- **Standby relay forward** (`a2a-cross-machine-route.md`, built): a standby's A2A send is
  forwarded to the machine holding the relay connection; `deliveryPath: 'forwarded'`. A
  standby's relay is `disconnected` BY DESIGN; the relay admits one connection per identity
  and displaces the previous one.
- **Telegram origin**: `TelegramOriginService` (admit → claim → authorize → execute), durable
  store whose `recordOperationState` already accepts `held|suppressed|expired|admitted` and
  whose `expireOperation` already writes `expired-unresolved` durably — neither is called from
  the hold path; recovery schedule (15-min review interval, 6 h deadline, 9 attempts);
  in-memory held map; `relayOriginBot` (two signed RPCs per forward: `capabilities`, `submit`;
  5 s default timeout each; forwards `sendMessage` only; mints the operation id inside
  `prepareBot`); the holder-side `submit` handler (`OriginMesh.ts:111-125`) checks only token
  presence and `executionOwnerMachineId === self` and then executes WITHOUT running
  `authorize` (it would execute a forward on a machine that lost the lease between
  `capabilities` and `submit`); `telegram.outboundRelay` throws
  `origin-credential-owner-unavailable` when `leaseHolder` is null or self.
- **Lease**: `LeaseCoordinator.holdsLease()` / `currentHolder()`; a standby learns the holder
  from `getSyncStatus().leaseHolder` (`/health → multiMachine.syncStatus`); `holdsLease()` is
  `true` on a single machine; right after a respawn the eventual holder reads `false` for a
  few seconds.
- **Config shape**: there is no top-level `telegram` key; Telegram-origin settings live in
  `messaging[].config.messageOrigin` and are migrated by the array-aware
  `migrateTelegramOriginDisplay` (`OriginConfig.ts:30`) because `applyDefaults` treats arrays
  as opaque leaves.
- **Attention priorities**: `low | medium | high | critical`; `createAttentionItem` is
  idempotent on `id`.
- **File routes**: `src/server/fileRoutes.ts` — `NEVER_SERVED_PREFIXES` (code-owned, prefix
  match, includes `.instar/machine/`, `.instar/secrets/`, `.instar/machines/registry.json`,
  `.instar/config.json`, the identity-store auto-accept protected paths), `blockedFilenames`
  (config-editable via `PATCH /api/files/config`; the matcher handles `*.ext` and `prefix.*`
  only), routes `read`, `download`, `list` (capped at 500 entries), `link`. `BackupManager`
  has an `includeFiles` list and a never-backup list; `.instar/identity.json` is in neither.
- **Migration**: `PostUpdateMigrator.migrate()` (≈75 ordered `migrate*` steps);
  `migrateConfig` merges `ConfigDefaults.getMigrationDefaults()` adding missing TOP-LEVEL keys
  only; `migrateGitignore` exists; `migrateClaudeMd` with content-sniffing guards; dev-gated
  flags resolve through `resolveDevAgentGate(explicit, config)` and must be registered in
  `DEV_GATED_FEATURES` (`scripts/lint-dev-agent-dark-gate.js` enforces it).
- **The relay** is ONE shared deployment (`DEFAULT_RELAY_URL`) used by every instar agent, so
  any relay protocol change must be additive and tolerate old clients.

## Threat model

- **A hostile or compromised sibling machine requests the agent identity.** Mitigated on the
  serving side by the verifiable set: the request is signed by a REGISTERED ACTIVE machine
  key, the payload is sealed to that machine's REGISTRY encryption key (never a key named in
  the body), at most one share per requester per 10 min, every share audited on both sides and
  announced once. "The requester has no identity" is a REQUESTER-side invariant the server
  cannot observe; the one corroboration the server can do (refuse when the requester's own
  observe answer carries a fingerprint) is done. Not mitigated, and stated plainly: any
  machine that is a legitimate sibling already holds the same private key (the parent spec's
  accepted "compatibility bridge" cost). De-pairing rotates the recipient key (existing) but
  does not revoke a copy already held; rotation of the whole agent identity remains the only
  revocation and is out of scope here (tracked, §Out of scope).
- **A fabricated identity is pushed to a machine with none.** Mesh RESPONSES are unsigned
  today and the LAN ropes are `http://`, so an on-path host could answer every observation
  with fingerprint X and serve X's keypair. Mitigated: the new verbs' responses are signed by
  the responder's registry-pinned machine Ed25519 key over `{fingerprint, requesterNonce}` /
  `{sealedEnvelope, fingerprint, requesterNonce}`; the requester verifies per machineId before
  counting an observation or opening an envelope; private↔public correspondence is verified
  at install, before the write; the envelope's fingerprint must equal the value EVERY active
  sibling signed AND this machine's own last-known published fingerprint when one is
  recoverable from local durable state (§1.3). With ONE active sibling, "unanimity" reduces to
  "that sibling is honest, registered and signs" plus the local last-known pin — stated, not
  implied away.
- **A stale or wrong "canonical" is auto-written over a working identity.** Not possible by
  construction: adoption fills a VOID (no file at either path and `IdentityManager.get()` null)
  and never writes over an existing, invalid or encrypted file. Replacing one is the parent's
  operator-selection ceremony, now wired (§1.4), with a timestamped backup before the rename.
  The PIN is entered on one machine and the write happens on another, so the replace order is
  a signed, operator-bound, single-use mandate the target verifies — never a bare peer call.
- **A detector that pages on healthy fleets trains the operator to ignore it.** Mitigated by
  §2: one formula, a semantic test that asserts `agree` on identical keys, a test that asserts
  the sha256 form is never compared to a routing fingerprint, and an out-of-process
  corroboration (the relay's own view of the agent) so a unanimous-but-wrong fleet is still
  caught.
- **A notice flood when a peer goes dark, or when MY relay is down.** Mitigated: one item per
  peer per episode through the existing escalate-once sentinel, a single aggregated item when
  the cause is local (relay not connected, or ≥2 peers crossing in one window), cooldown per
  peer, dry-run first. Peer display names are rendered as fingerprint prefix + clamped,
  escaped name (untrusted).
- **The forward-to-holder path becomes an amplifier or a loop.** Mitigated: the holder's
  `submit` runs `authorize` and answers a typed `not-lease-holder` refusal (today it does
  not — a factual gap this spec closes); a forwarded operation keeps its ORIGINAL operation id
  across retries so the holder dedupes; an `outcome-unknown` forward is never re-sent blind;
  the standby never also executes locally.
- **Key material leaves via any read surface.** Mitigated by §5: the deny list is code-owned
  and config-immune, checked on the RESOLVED path, applied to `read`, `download` and `list`,
  mirrored into the backup never-list, the gitignore entries and the secret classifier, and
  anchored on a code-owned manifest of every key-writing call site of the single owner-only
  writer — with a behavioural fixture walk that can disagree with the list.

## Design

### 1. One identity, kept converged — not only carried at join

**1.1 Close the second mint site.** `createUnifiedTrustSystem` keeps both of its existing
branches under `!identity.exists()` — the legacy migration (reuse of
`.instar/threadline/identity.json`) is untouched — and guards ONLY the `create()` call with the
same `detectJoinedMesh(stateDir)` predicate `getOrCreate()` uses. The predicate's readings:

- no registry file at all → standalone first machine → mint, exactly as today;
- a registry naming any other row (active, pending OR revoked — the safe direction for a
  mint guard) → joined → refuse;
- a registry file that EXISTS but is unreadable or unparseable → refuse (fail closed). The
  parent let an unreadable registry resolve toward minting so an unrelated filesystem fault
  could not deny a standalone agent its identity; a corrupt registry on a machine that HAS
  one is not a standalone agent, and minting there is exactly how a rebuilt sibling recreates
  the split. The refusal names the registry as unreadable.

A refused mint boots the server in an explicit `identity-not-provisioned` posture:

- the relay connection is not attempted (there is no identity to connect as);
  `/threadline/health` reports `relay.state: 'not-provisioned'` with `fingerprint` absent;
- **the machine is lease-ineligible**: it declines to acquire the serving lease and, if it
  holds one at boot, releases it at the next tick. The relay admits one connection per
  agent and a standby never connects, so an unprovisioned lease holder would take the WHOLE
  fleet off the agent network while the key sits on its siblings. Single-machine: nothing to
  release; the posture is loud on its own.
- `DegradationReporter.report({feature: 'Threadline.identity', reason: 'joined machine has no
  agent identity', impact: 'not reachable on the agent network until the identity is adopted'})`
  — the audit row, written on the SAME tick as detection (No Silent Degradation);
- the adoption loop (§1.2) — the self-heal — starts immediately. The operator is NOT notified
  on first detection: one HIGH attention item `agent-identity-missing:<agent>:<machineId>` is
  raised only when adoption has been REFUSED for a fleet reason (non-unanimity, an unreachable
  or not-yet-updated sibling, a verification failure, a last-known mismatch) on 4 consecutive
  observe rounds, or when 120 s have passed since detection without success — whichever comes
  first. `rate-limited` never counts toward that breaker. The item body names the reason and
  the lever (§1.8). Adoption keeps retrying after the item is raised; the item resolves itself
  on success.

Mint-site census (the structural arm): a unit test enumerates every call site in `src/` of
`generateIdentityKeyPair(`, `CanonicalIdentityManager.create(`/`identity.create(` and
`getOrCreate(` and classifies each against a code-owned allowlist BY FILE: the two guarded
agent-identity mint sites (`UnifiedTrustWiring.ts`, `client/IdentityManager.ts` —
each must call `detectJoinedMesh(` in the same function body), the primitives' own bodies
(`identity/IdentityManager.ts`, `identity/KeyRotation.ts`) and the non-agent key users
(`relay/A2ABridge.ts`, `relay/RegistryAuth.ts`). The predicate for "an agent-identity mint"
is: the site writes `identity.json` or `threadline/identity.json`. A NEW, unlisted site fails
the build. The expected set is stated by file, never by count.

**1.2 Post-pairing adoption: two new mesh verbs.** A paired machine with NO identity (no file at
either path and `IdentityManager.get()` returning null) asks its siblings for it:

- **Observe (read, every round).** Requester → each ACTIVE registered sibling: MeshRpc
  `agent-identity-observe` `{agentName, requesterNonce}`. The response
  `{fingerprint | null, state: 'provisioned'|'not-provisioned', requesterNonce, sig}` is signed
  by the responder's registry-pinned machine Ed25519 key over the first three fields; an
  unsigned, mis-signed or nonce-mismatched answer is discarded as `unverified` (counts as
  unreachable). A sibling on an older version answers `no-handler`; that is `cannot-tell` for
  ADOPTION (adoption installs a key, so it never falls back to the unsigned `/provenance`
  read), and the refusal names the sibling to update.
- **Request (write, only when unanimous).** The requester sends `agent-identity-request`
  `{agentName, expectedFingerprint, requesterNonce}` to ONE sibling that published the
  unanimous value — rotating to the next unanimous responder on any typed refusal — and never
  before 10 min have passed since its own last request (it honours the server's window; a
  `rate-limited` answer is a scheduling fact, not a fleet fact). At most one request is in
  flight.
- Serving sibling refusals, each typed: `not-registered` (sender not an active registry row —
  the existing mesh permission class), `no-usable-identity` (own identity unreadable),
  `unknown-origin-identity` (own provenance absent/unknown AND no ceremony record names its
  fingerprint as chosen — §1.4), `fingerprint-mismatch` (`expectedFingerprint` ≠ own),
  `requester-publishes-identity` (the requester's own `agent-identity-observe` answer, read
  back by the server before serving, carries a fingerprint — the one void-check the server
  CAN do), `rate-limited` (one share per requester per 10 min, with `retryAfterMs`).
- Payload: the identity sealed with `encryptForSync` to the requester's REGISTRY
  `encryptionPublicKey` (the key `secret-share` already seals to); the request carries no
  key field. The envelope `{sealed, fingerprint, fingerprintFormula: 'routing-v1',
  requesterNonce, provenance, adoptedFrom: {machineId, at}}` is signed by the serving
  machine's registry-pinned key. The provenance record travels as DATA (today's code has no
  signature on it, and this spec does not rely on one).
- Requester acceptance (§1.3), then install through `installAgentIdentityFromPairing`'s
  atomic owner-only write (reused) after verifying private↔public correspondence IN MEMORY —
  a mismatched pair is refused `keypair-mismatch` and nothing is written. Then the
  `IdentityManager` cache is reloaded, the lease-ineligibility is lifted, and a NORMAL relay
  connect follows on the next tick — no restart. Identity mutations on one machine are
  serialized by a lock file (`identity.lock`, O_EXCL, pid-stamped, stale-after-60 s) shared by
  adoption, the ceremony commit (§1.4), the mirror repair (§1.5) and `instar join`; a
  concurrent mutation waits or refuses `identity-locked`, never interleaves.
- Audit: both sides append a row to `logs/agent-identity.jsonl` on every reason TRANSITION
  (not every attempt) plus a bounded hourly heartbeat while refused (`shared-to` /
  `adopted-from` / `refused:<reason>`, fingerprint, machine ids; NEVER key material or the
  sealed payload). Exactly ONE `medium` attention item per adoption episode, raised by the
  ADOPTING machine on success: "I adopted my agent identity (63b1dbb2…) from <nickname>" —
  a key copy is an event the operator must be able to see, and it is one event however many
  siblings were observed. Serving siblings only audit; they never raise.

This is deliberately a separate verb from `secret-share`: the identity is credential-class
(cf. `AccountCredentialShare`), it must never ride the general secret set, and its response
must be signed — which `secret-share` is not.

**1.3 Which identity to adopt: unanimity of the ACTIVE fleet, pinned by local memory, or
refuse.** A machine with no identity adopts an identity only when ALL of the following hold
in one observe round:

- every sibling whose registry row is ACTIVE (`isRegistryEntryActive`: `status === 'active'`
  and no `revokedAt`) was reached and answered with a VERIFIED signature;
- every answering sibling in state `provisioned` published the same fingerprint, and at least
  ONE such sibling exists (`not-provisioned` responders — another rebuilt machine — are
  excluded from the quorum, not counted as disagreement);
- the sealed envelope's public key hashes (routing formula) to exactly that value, under a
  signature that verifies for the serving machine;
- when this machine can recover its own LAST-KNOWN published fingerprint from local durable
  state (in order: `threadline/agent-info.json`, the A2A ledger's sender column, the newest
  `identity.json.superseded-*`/`.invalid-*` backup's public key), the envelope's fingerprint
  equals it. A mismatch is `last-known-mismatch` → refuse → ceremony. This is the pin that
  makes a one-sibling fleet more than one machine's word: the machine that lost its key still
  remembers which address it used.

Any unreachable or not-yet-updated active sibling, any disagreement, any verification
failure, any last-known mismatch → refuse, stay `identity-not-provisioned`, keep the attention
item open with the observed set and the exact reason named. Revoked rows are excluded from the
quorum and NAMED in the refusal when they are the only siblings ("your only sibling was
removed on <date>"). The parent spec rejected peer MAJORITY as authority for choosing BETWEEN
candidates; this rule is narrower and different in kind — it fills a void with the single value
the whole active fleet signs for, cross-checked against this machine's own memory, and refuses
whenever either is missing. It cannot pick a wrong identity unless every active sibling is wrong
at once AND this machine has no memory of its address, which is the state the operator ceremony
(§1.4) exists for and which this rule explicitly refuses to touch.

**Mixed-wake fleets, stated honestly.** A Laptop or Mama PC that is asleep is an unreachable
active sibling, so in this fleet the self-heal will often refuse and the 120 s item will be the
NORMAL path for a rebuilt machine, not the exception. The ceremony is therefore made cheap:
the item carries a one-tap dashboard action ("adopt the identity <nick1> and <nick2> publish;
<nick3> was unreachable") that drives §1.4's commit with the PIN. The alternative — adopting
on a presence-window quorum — was rejected: in the live incident the ONLY reachable machine
for days was the one with the wrong identity.

**1.4 Wire the operator-selection ceremony.** `decideReconciliation` becomes reachable through
a NEW dashboard surface on the Machines tab (`dashboard/index.html`; the tab exists, the
plan/commit panel is new) backed by:

- `POST /agent-identity/reconcile/plan` (Bearer) renders the candidate set in the parent's
  human terms ("the identity your Mini, Laptop and Mama PC have used since May" vs "the one
  the Studio created for itself on 26 August"). Candidates = the last confirmed `disagree`
  set from §2.2, each machine's provenance record, every `identity.json.superseded-*` /
  `identity.json.invalid-*` backup found on any online machine (so a wrong choice is reversible
  through the SAME surface), and an explicit "mint a NEW agent identity — every peer must
  re-pin" option for a fleet with no candidate at all. A plan id expires in 15 min and is
  single-use.
- `POST /agent-identity/reconcile/commit` `{pin, planId, chosenFingerprint, targets}`
  (dashboard PIN). The committing machine issues, for each target, a signed
  **replace mandate** `{targetMachineId, chosenFingerprint, planId, nonce, expiresAt ≤15 min,
  operatorSession}` under its registry-pinned machine key, and delivers it with the sealed
  identity (obtained from the first online holder of the chosen fingerprint through
  `agent-identity-request` carrying the mandate) via a third verb `agent-identity-replace`.
  The target verifies the issuer against the registry, the nonce (single use), the expiry and
  that the sealed key hashes to `chosenFingerprint`; backs up the superseded file as
  `identity.json.superseded-<ISO>` (owner-only, through the single writer) BEFORE the rename;
  installs; reloads the cache; reconnects the relay. Anything else is a typed refusal. A
  commit MAY target an unprovisioned machine — the PIN overrides unanimity, which is the
  cheap-ceremony path §1.3 points at.
- The commit record (candidate set, chosen fingerprint, targets, operator, time) is written
  and REPLICATED through the coherence journal (the existing content-free lifecycle carrier
  that already replicates on the fleet; the `stateSync.*` stores ship dark there and are not
  used). It is the ONE operator-authorized automatic replacement: a machine that comes back
  online later — or is restored from a pre-ceremony backup — whose identity ≠ the record's
  chosen fingerprint and whose record is newer than its identity's install time applies the
  record on boot through the same replace path (backup rule included). A wrong choice is
  undone by a second ceremony picking the superseded backup.
- No other path ever rewrites an existing identity. The routes are how the agent reads and
  renders; the operator taps the dashboard (Mobile-Complete Operator Actions).

**1.5 The legacy file is a mirror, repaired at first load — and it is the listener daemon's
primary key, so the repair is NOT cheap.** When `IdentityManager.loadFromDisk()` finds both
files and they disagree, the canonical one wins (as today) AND the legacy file is rewritten
to match — by the single writer the `threadline-identity-single-writer` spec designates, under
the identity lock, atomically, with the old legacy file backed up as
`threadline/identity.json.superseded-<ISO>` — and ONE degradation row says so. Because the
listener daemon loads the legacy path as ITS identity, a running daemon is signalled to
reload (or restarted) after the repair, so it cannot keep a relay connection under the
superseded key and displace the server's. The repair happens at the first load of each
process (the manager caches afterwards). Today's manual fix left exactly this disagreeing
state and the server logs an `[identity]` ERROR at every boot; a mirror that disagrees is
noise with no decision behind it.

**1.6 Set the join-time pin.** `instar pair` prints the agent's ROUTING fingerprint beside the
code and embeds it in the pairing URL as `afp=<32hex>`; `instar join` accepts
`--agent-fingerprint` (overrides) and otherwise reads `afp` from the URL; an old joiner ignores
the parameter; with neither, today's self-pin applies and a warning is printed. The envelope
gains `fingerprintFormula: 'routing-v1' | 'sha256-v0'`; a joiner verifies the envelope under
the formula it STATES and compares to a pin of the same formula (a sha256-form envelope from an
old awake machine is accepted during the transition window against the self-pin only). An
existing provenance `rootFingerprint` (sha256 form on the three healthy machines) is compared
for PRESENCE only, never for equality with a routing value; roots are rewritten in routing
form on the next successful load.

**1.7 Join-time fallback.** When a join completes without an identity envelope (old awake
machine), the joiner no longer stops at "update it and re-pair": it boots in
`identity-not-provisioned` posture and runs §1.2–1.3, which succeeds the moment every active
sibling runs a version that answers `agent-identity-observe` and the fleet is unanimous. Until
then the item names the sibling(s) to update.

**1.8 Escape hatches — a fleet can never be locked out.** Named in the attention item that
needs them:
- a decommissioned sibling that blocks unanimity → `instar machines remove <name>` (or the
  Machines tab), after which the next round can succeed;
- every machine identity-less (registry intact) → the ceremony's "mint a NEW agent identity"
  option (peers re-pin), or a superseded backup candidate; AND a local operator CLI
  `instar identity init --standalone --i-understand-peers-must-repin` run in a shell on the
  machine (a local shell is the operator; audited; provenance `minted-by-operator-recovery`),
  so no network path is required to recover a fleet;
- an identity file that is present but invalid or encrypted → never adopted over; the
  ceremony moves it to `identity.json.invalid-<ISO>` (a candidate) and installs the chosen key.

### 2. Loud cross-machine mismatch: one formula, one episode, one item

**2.1 One comparison value.** The routing fingerprint (`computeFingerprint`, raw public-key
prefix) is the ONLY value ever compared across machines or against a peer's pin.
`AgentIdentityHandover.fingerprintOf` is changed to it (with the §1.6 formula stamp carrying
the transition); `canonicalId`/`displayFingerprint` stay what they are (trust-system
identifiers) and are never placed in a routing comparison.

**2.2 The fleet floor: the detector, fixed and continuous.** The existing boot task stays
(always on, every machine, no flag — a dark identity check checks nothing) with these changes:

- the formula fix;
- it runs on every presence tick (30 s), with an in-flight guard (no overlapping runs);
- its SELF value is read from the on-disk file through the single reader (NOT the in-process
  cache — the cache is what the relay client holds, and a file repaired without a restart
  must be able to disagree with it); its PEER values are read from the presence registry's
  clamp-passed `coherenceAdvert.agentFingerprint` (§2.3) — zero extra requests; a peer whose
  advert lacks the field (older version) or is stale past `advertStaleMs` is `cannot-tell`,
  with a one-shot unsigned `/provenance` read used only to ENRICH the item text, never to
  decide;
- the verdict: `disagree` whenever ANY two observed values differ — an unreachable member
  never hides a demonstrated split; `cannot-tell` only when fewer than two values were
  observed and none differ; `agree` only when every ACTIVE sibling was observed and all
  values match;
- the item id is `agent-identity-split:<agent>:<sorted fingerprint set>`; any machine may
  RAISE (after `flagConfirmTicks` consecutive `disagree` reads); only the serving-lease holder
  may RESOLVE, and only after `flagConfirmTicks` consecutive full-set `agree` reads — two
  observers with different reach cannot churn one item;
- K consecutive `cannot-tell` rounds (default 10) against the same peer, after the self-heal
  (re-pull that peer's presence), produce one degradation row and ONE `medium` item
  "identity check cannot run against <nick>"; `identityCoherence.cannotTellRounds` exposes it.
  A split must not be able to hide behind a slow peer forever.

**2.3 The coherence dimension.** `CoherenceAdvert` gains `agentFingerprint` (32 hex, validated
by a hex regex in `clampCoherenceAdvert` — BOTH the clamp whitelist and the N5 ratchet's
reference advert gain the field, measured at +54 B → 1408 B of the 2048 B budget; an older
peer without the field is `compared` on the other dimensions and `unknown` on this one —
never `advert-rejected`). `SkewDimension` gains `identity`. An `identity` row is ALWAYS loud
(`high`, never calm), is NOT suppressed by version skew (an identity split is independent of
the version that produced it), confirms after `flagConfirmTicks`, and is worded by
`guaranteeFor('identity')`: "my machines are not the same me on the agent network — <nick>
publishes X, the others publish Y; messages addressed to Y are lost while <nick> holds the
relay". When the guard raises an identity row it uses the SAME item id as §2.2. The guard
rides its own existing gate (`monitoring.machineCoherence`), so on the fleet §2.2 alone
speaks and the fleet read is `GET /threadline/health → identityCoherence`; on dev both agree.

**2.4 The out-of-process corroboration.** The machine that holds the relay connection
additionally compares, each tick: (a) the fingerprint it CONNECTED as (`relayClient.fingerprint`),
(b) the relay's own view of this agent (the `discover` self-lookup / `/v1/registry/me` row for
my `agentId`, when listed), and (c) the recipient fingerprint on inbound envelopes over the
last 7 days (from the inbound ledger). A fleet-unanimous value that the relay row or the
inbound recipients do not match raises the §2.2 item with "the network addresses X; my
machines publish Y" as the named discrepancy — this is the check that catches a unanimous-but-
wrong fleet after a wrong ceremony choice, which no in-fleet comparison can. `/threadline/health`
reports `identityCoherence: {state, connectedAs, siblingsPublish, relayPublishes,
inboundAddressed, cannotTellRounds}`.

### 3. Honest sender-side reporting of a send that stays queued

**3.1 Classification.** `A2ADeliveryTracker.peerHealth()` gains `dark` and `darkSince`: a peer
is `dark` when its oldest row that is `awaiting-ack`/`queued`, `unconfirmed`, or
`failed`+`expired` — and NEWER than the last ack and last inbound from that peer — is older
than `queuedDarkAfterMs` (default 2 h). A peer leaves `dark` ONLY on an ack, an inbound, or a
`delivered` verdict (the same `expiredNewer` shape the existing `stale` rule uses; relay
expiry alone never clears it, so a persistently dark peer is one episode, not one per day).
`stale` (6 h) is unchanged. The query rides the `(peer_fp, state)` index with
`ORDER BY sent_at ASC LIMIT 1`; no retention is added; `allPeerHealth` is bounded to peers with
activity in the last 30 days.

**3.2 Where it is said.**

- **In the send response (raw fields live, sentence gated).** `POST /threadline/relay-send`
  (and the `threadline_send` tool result, whose schema is additive) answers a send to a dark
  peer with `peerDark: {since, queuedCount, expiresAt, relayLastSeenAt?}`. The
  `deliveryOutcome` SENTENCE — "no acknowledgement from <peer> for N h; this and K other
  messages are still queued (oldest expires T); it may be offline, or listening under a
  different address — see `GET /threadline/health → identityCoherence` for the split cause" —
  is worded to the evidence (never "nothing will arrive") and rides the same dry-run flag as
  the notice, so a wrong threshold reaches the agent's reply only after the flip. Peer names
  render as fingerprint prefix + a clamped, HTML-escaped display name (untrusted).
- **On the health read.** `GET /threadline/peers/health` and the per-peer route carry `dark`,
  `darkSince`, `queuedCount`, `relayLastSeenAt`; pool scope merges as today.
- **To the operator, once — through the EXISTING sentinel.** `A2ARedeliverySentinel` already
  escalates once per peer with ONE aggregated item and has an escalate-only mode. §3 does not
  build a second notifier: the `dark` classifier becomes the sentinel's trigger, run in
  escalate-only mode (`redeliver` omitted, `raiseAttention` wired, trigger = `dark &&
  queuedCount > 0 && selfHealExhausted`), and its item id becomes the deterministic
  `a2a-peer-dark:<agent>:<peerFp>:<episode>` (replacing `a2a-redelivery-${Date.now()}`).
  The item: "Messages to <peer> are stuck: K queued since T, none acknowledged. <peer> may be
  offline, or may be listening under a different address." It resolves when the peer leaves
  `dark`; per-peer cooldown 12 h; a peer that flaps 4× in 24 h is reported once as
  "intermittent" with a doubled cooldown.
- **Aggregation when the cause is local.** If my own relay is not `connected`, or ≥2 peers
  cross into `dark` within one sweep window, ONE aggregated item is raised ("relay unreachable
  from this machine; K peers, M messages queued" / "K peers went dark together") and per-peer
  items are suppressed until the relay is back / the window closes.

**3.3 The self-heal, and where it may run.** Before blaming the peer, fix my side — but ONLY
on the awake (telegram-polling) machine, because a standby's relay is `disconnected` BY DESIGN
and reconnecting it would displace the live holder: (1) if this machine is the awake machine
and its relay is `disconnected`/`displaced`, `reconnectRelay()` (idempotent, the existing
re-arm); (2) re-issue `discover` to refresh presence (read); (3) run the §2 identity check on
myself (read) — if I am the split one, that item supersedes this one. On a standby the heal
is skipped with reason `standby` and the ledger is proxied-on-read only. Two passes 40 s apart,
inside the 120 s ceiling.

**3.4 Relay-side enrichment (additive, first-party).** The relay is one shared deployment this
project owns, so the cheapest honest signal is added there: the `queued` ack gains
`recipientLastSeenAt` (from the relay's connection log for that fingerprint; absent when the
relay has never seen it connect). Old clients ignore the field; a sender treats its absence as
UNKNOWN, never as "never connected" (the relay's registry lists only agents that chose to be
listed, and the connection log is bounded). The sender surfaces it as `relayLastSeenAt`.

**3.5 Rollout.** `threadline.peerDarkNotice: {dryRun: true, queuedDarkAfterMs: 7200000,
cooldownMs: 43200000}` with `enabled` OMITTED (dev-gate resolution; registered in
`DEV_GATED_FEATURES`). Dry-run logs would-raise rows and would-sentence rows to
`logs/a2a-peer-dark.jsonl`; the raw fields are live from the first build (they are reads).

### 4. ACT-058 — a reply from a machine that does not hold the lease is forwarded; a failed forward is held durably and reported

**4.1 Forward before hold.** The send decision in `TelegramAdapter.sendToTopic` (`:1392`, and
its mirror `willRelay()`) becomes "no usable bot token OR (session pool enabled AND
`!holdsLease()`)". A standby that owns a topic therefore sends its reply through
`telegram.outboundRelay` → `relayOriginBot` to the lease holder — preparing the operation
with `executionOwnerMachineId = holder` so the holder's execution-owner check passes. The
holder-side `submit` handler (`OriginMesh.ts`) gains the SAME `authorize` (lease) check the
direct path runs and answers a typed `not-lease-holder` refusal when it does not hold the
lease (today it executes without checking — a forward landing on a machine that lost the
lease between `capabilities` and `submit` would be executed by a non-holder). The holder
records the origin with `deliveryMachineId = holder` and `forwardedFromMachine = standby`;
the reply lands in the topic with its normal origin footer. The standby never also executes
locally. `capabilities` is cached per `(holder, leaseEpoch)` so a forward is ONE RPC in steady
state. In v1 only `sendMessage` is forwarded; media, edits and pins from a standby go to the
durable, reported hold of §4.2 (named, not silent).

**4.2 Lease settling, retry ladder, then a durable hold that says so.**
- **`lease-settling` (no hold yet).** When `leaseHolder` is null, or equals self while
  `holdsLease()` is false (the few seconds after a respawn), the send re-reads the lease with
  backoff inside a bounded in-process window (≤60 s) BEFORE anything is written. A lease that
  settles to self sends locally; one that settles to a peer forwards. No row, no notice, no
  item for a settling window.
- **In-process ladder.** A forward that fails with a typed `retryable` refusal (holder capacity,
  timeout, `not-lease-holder` because the lease just moved) is retried 3× at 10 s intervals,
  re-resolving the holder each time; a 5-second blip must never become a 15-minute delay.
- **Durable hold.** Only `forward-to-holder-failed` (holder known, forward refused or
  unreachable after the ladder) holds: the EXISTING `recordOperationState('held')` is called
  (today it never is) with a new `hold_reason` column = `lease-not-held` — a NEW reason,
  distinct from `destination-not-authorized`, which keeps meaning "foreign chat" and stays
  excluded from forwarding and from notices. The store's no-op cases (`recordOperationState`
  returning `false` for `accepted|expired|outcome-unknown|partial`) leave the operation in its
  terminal state and are audited. The in-memory held map becomes a cache of the store. Older
  readers of the store treat an unknown `hold_reason` as `admitted` (additive, no schema
  bump).
- **Recovery re-forwards the SAME operation.** The recovery tick re-submits the held
  `OriginPreparedBotOperation` with its ORIGINAL operation id and sealed record (the holder
  dedupes on it); it never re-prepares, never re-authorizes locally. On a holder change while
  an attempt is `outcome-unknown`, it does NOT re-prepare for the new holder: it queries the
  old holder's origin store (`telegram-origin` `status` action, existing) and stays held with
  `effect-unknown` until that answers or the deadline passes — a double post is structurally
  impossible.
- **The notice.** `onHold` admits `lease-not-held`. The fixed outage template ("I have your
  message; my reply is delayed while it is routed through <holder nickname>") is sent THROUGH
  the holder (the notice policy's `ownershipValid` is satisfied by "the holder sends it"). If
  the holder cannot be reached for the notice either, the hold is still never silent: `/health`
  carries a `telegramOrigin.heldForward` degradation, `/telegram/origins/status` lists it under
  `held` with `hold_reason: lease-not-held`, and ONE `high` attention item names the topic and
  the holder. Three topics held on one standby within 1 h collapse to one aggregated item.

**4.3 Expiry is a reported outcome, with honest wording.** A held operation that reaches its
deadline is recorded through the EXISTING durable `expireOperation` (`expired` + child
`expired-unresolved`; today the hold path never calls it). The expiry raises the same
per-topic item with wording that distinguishes `expired-unresolved` ("I could not deliver my
reply to <topic> within 6 h") from `effect-unknown` ("my reply to <topic> may or may not have
been delivered; the machine that was sending it did not confirm").

**4.4 Named dependency, not claimed.** ACT-058 also records an ownership-registry divergence
(the holder's registry names an owner that has no record of owning the topic, so
`/pool/transfer` degrades to `refused-not-owner` and the pin never actuates). That is a pool
ownership defect under the WS1.3 reconciler, tracked as its own evolution action (§Out of
scope); §4 makes a standby-owned topic ANSWERABLE regardless of whether the ownership record is
coherent.

**4.5 Rollout.** The switch lives where the other origin settings live:
`messaging[].config.messageOrigin.forwardToHolder: {enabled: true, dryRun: false}`, added by
extending the array-aware `migrateTelegramOriginDisplay` (a top-level key is unreachable for
an array entry, and the CLAUDE.md template says so twice). Code default `dryRun: false`
(reachability is a safety floor the constitution forbids dark-shipping — "The Agent Is Always
Reachable", corollary 2). The builder writes `dryRun: true` into the DEV agent's config
explicitly, the build run ENDS there, and a commitment with `checkInAt` = +48 h flips dev on
a clean `logs/telegram-origin-held.jsonl` soak (zero would-forward errors) — the flip is the
builder's under the standing merge authority, not an operator decision. Single-machine agents
are a strict no-op (`holdsLease()` is always true).

### 5. Key material is never served, backed up, synced or listed — by lists the config cannot loosen

**5.1 Extend the code-owned deny list.** `NEVER_SERVED_PREFIXES` gains, as PATH PREFIXES (the
matcher is prefix-only; no glob syntax is introduced): `.instar/identity.json` (covers its
`.superseded-*`/`.invalid-*` siblings and the single writer's temp names, which share the
prefix), `.instar/threadline/identity.json`, `.instar/threadline/inbox-hmac.key`,
`.instar/threadline/invitation-secret.key`, `.instar/threadline/secure-invitations.json`,
`.instar/machine-ssh/` (covers the `*-ed25519-g*` files), `.instar/state/inbound-delivery.hmac-key`,
`.instar/relay-tokens.json`, `.instar/local-state/` (holds only the worktree key vault and
origin sockets/sessions — no operator-readable audit file lives there today),
`.instar/origin-sessions-`, `.instar/state/conversation-bind-token.secret`. Only the KEY files
under `.instar/threadline/` are denied, not the directory: `conversations.json`,
`trust-profiles.json` and the thread history are the operator's own audit surfaces (the
dashboard Threadline tab reads them) and stay readable. The list stays config-immune:
`PATCH /api/files/config` can narrow `allowedPaths` and extend `blockedFilenames` but can
never remove a never-served entry. This is exact-path access control, not a meaning filter;
Signal vs. Authority governs who may block on MEANING and does not apply to an enumerated
floor.

**5.2 Check the resolved path, everywhere.** `checkBlockedFilename` and the never-served
check run on BOTH the requested path and the `realpath`-resolved one, in `read`, `download`,
`list` (which realpaths EACH entry, so a symlinked file with an innocent name inside an allowed
directory is hidden, not listed) and `link`. A `realpath` failure (dangling symlink) refuses.

**5.3 The same list guards every other read surface.** The identity files and their siblings
are added to `GITIGNORE_ENTRIES` (with a `migrateGitignore` step), to `DEFAULT_SECRET_PATTERNS`
in the file classifier (as prefixes, so backups are secret-classified), to `BackupManager`'s
never-backup list (an operator adding `identity.json` to `backup.includeFiles` must not ship
the key in a replicated snapshot), and the working-set carrier refuses them by the same
classifier.

**5.4 The ratchet — a manifest at the single writer, and a walk that can disagree with it.**
Two arms, because a token grep cannot derive the path a key is written to:
- **Static.** Every call site of the owner-only writers (`writeFileAtomicOwnerOnly`,
  `createFileExclusiveOwnerOnly`, and any `writeFileSync` with `mode: 0o600`) must name its
  project-relative target in a code-owned `KEY_FILE_MANIFEST`; a unit test asserts the
  manifest ⊆ (never-served ∪ never-backup ∪ gitignore ∪ secret-classifier) on resolved paths,
  and that no owner-only write exists outside the manifest. An unlisted writer fails the
  build.
- **Behavioural.** A fixture agent home is booted through the real init path, paired to a
  stub sibling so every key-bearing file is produced; the test walks `.instar/` for files with
  mode 0600 or JSON containing a `privateKey`/`secretKey` field and asserts each is refused by
  `read`/`download`/`list`, excluded from backup, and secret-classified. This arm is the one
  that can disagree with the manifest.

**5.5 No flag.** This is a security floor; it ships live with no config. A one-line release
note says what became unreadable through the Files tab.

## Decision points touched

| Decision point | Change | Classification |
|---|---|---|
| `createUnifiedTrustSystem` canonical mint | new refusal: no mint when `detectJoinedMesh` names a sibling or the registry is unreadable; boots `identity-not-provisioned` | invariant — an on-disk fact decides; no registry → mint, any sibling row or an unreadable registry → refuse; there is no competing signal to weigh, and the one human lever is the local recovery CLI (§1.8) |
| `identity-not-provisioned` → lease-ineligible | new | invariant — a machine with no routing identity cannot serve the relay; deterministic |
| `agent-identity-share` serving refusals (`not-registered`, `no-usable-identity`, `unknown-origin-identity`, `fingerprint-mismatch`, `requester-publishes-identity`, `rate-limited`) | new | invariant — each is a deterministic predicate on local state or a signed read; the verb hands out a private key, so no judgment may widen it |
| Adoption acceptance (§1.3 active-fleet unanimity + last-known pin) | new refusal on any gap | invariant — deliberately: choosing an identity is the irreversible act this spec exists to prevent being guessed; the only non-deterministic path is the operator ceremony (the human arbiter, not an LLM) |
| `agent-identity-replace` mandate verification | new | invariant — registry-pinned issuer signature, single-use nonce, expiry, fingerprint match; the human is the arbiter (Know Your Principal) |
| `POST /agent-identity/reconcile/commit` | new PIN gate | invariant — dashboard-PIN + single-use plan id |
| Identity-divergence verdict (`agree` / `disagree` / `cannot-tell`) | changed: one formula, per tick, from the advert; `disagree` on any two differing observed values | invariant — equality of published fingerprints; `cannot-tell` for insufficient observation is the conservative default and never pages |
| `identity` skew row (always loud, not version-suppressed) | new | invariant — a `high`/never-calm mapping; the episode manager's confirm/dedupe/flap brakes apply unchanged |
| Per-peer `dark` classification (§3.1) | new signal | invariant — a time threshold over ledger rows; signal-only; thresholds are config |
| `a2a-peer-dark` raise (via `A2ARedeliverySentinel` escalate-only) | changed trigger + deterministic id | invariant — raise iff `dark && queuedCount>0 && selfHealExhausted`; the wording's "may be offline or under a different address" is honest uncertainty |
| `sendToTopic` / `willRelay()` | modified: also forward when the pool is on and `!holdsLease()`; `lease-settling` window first | invariant — `holdsLease()`/`leaseHolder` are the existing deterministic lease reads |
| Holder `submit` handler | new `authorize` (lease) check → typed `not-lease-holder` | invariant — the same predicate the direct path runs |
| Origin hold reasons | `lease-not-held` (new; forwardable, notifiable) vs `destination-not-authorized` (unchanged; never forwarded) | invariant — two distinct facts get two distinct reasons |
| Held-forward recovery | re-forwards the same operation on the 15-min schedule, 6 h deadline; `effect-unknown` never re-sent | invariant — bounded schedule the recovery store owns |
| File-route never-served list + resolved-path check + manifest ratchet | new denials in `read`/`download`/`list`/`link`, backup, gitignore, classifier | invariant — a code-owned path list; security floor; exact-path access control, not a meaning filter |

Nothing here grants authority: a shared identity is a routing key, not a permission; a
forwarded reply is still subject to the holder's full outbound gate (tone gate, credential
wall); an adopted identity does not establish an operator.

## Multi-machine posture

Default posture is `unified`. Each surface this spec introduces, with its posture:

- **The agent identity itself** — `unified`: one keypair, replicated to every sibling through
  the sealed handover (join), adoption (§1.2) and the replicated commit record (§1.4). The
  on-disk file is a per-machine COPY of one identity, verified equal by §2 on every tick.
- **`identity-not-provisioned` posture + adoption state** — `unified` by construction: it
  exists only on the machine lacking the identity, makes that machine lease-ineligible, and
  ends when the fleet's single identity lands there; the item names the machine.
- **Reconcile ceremony record (plan/commit)** — `unified`: replicated through the coherence
  journal (the existing content-free carrier that is live on the fleet), applied on boot by any
  machine whose identity differs from the chosen one.
- **`logs/agent-identity.jsonl` audit** — proxied-on-read: `GET /agent-identity/audit`
  (Bearer, read-only; `?scope=pool` merges every online machine's rows tagged by machineId,
  dark-peer tolerant; `?limit` default 200, `?since`, tail-read, per-machine byte cap).
- **Identity-divergence verdict / `identityCoherence`** — every machine computes it from the
  shared presence registry; one shared item id (raise anywhere, resolve only on the lease
  holder) makes the notice unified; `/threadline/health` is per machine and
  `GET /pool/machine-coherence` is the merged read where the guard is on.
- **A2A delivery ledger + `dark` state** — proxied-on-read: rows live on the machine that
  carried the send (the relay holder; a forwarded send is recorded on the holder as today),
  `GET /threadline/peers/health?scope=pool` merges. The item is raised by the awake machine
  (the only one whose heal may run) with an id keyed on `(agent, peerFp, episode)`.
- **Telegram origin held operation on a standby** —
  `machine-local-justification: physical-credential-locality` — the held record is an origin
  operation ATTESTED under the standby's machine signing key (`verifyOriginAttestation`), which
  lives on that disk; the design moves the WORK (the forward) to the holder rather than the
  record, and the record is visible from the pool via `/telegram/origins/status?scope=pool`
  (existing). A single machine is a strict no-op.
- **Relay connection** — unchanged: one per agent identity, on the awake machine
  (`physical-credential-locality`, pre-existing, not introduced here).
- **Never-served / never-backup / gitignore / classifier lists** — identical code on every
  machine; `unified` by construction.
- Every heartbeat/advert field added is tolerant of an older peer (absent → `unknown`, never
  `advert-rejected`); a new mesh verb answered `no-handler` by an older peer is `cannot-tell`
  for adoption and names the peer to update; a rolling update cannot itself raise an identity
  row.

## Watchers, self-heal and escalation (Self-Heal Before Notify)

| Watcher | Degradation class | Self-heal step + remediation-actions | Brakes | Escalation |
|---|---|---|---|---|
| **Missing identity on a joined machine** (§1.1) | `recoverable` | adoption: signed observe → active-fleet unanimity + last-known pin → one signed request → in-memory keypair check → atomic install under the identity lock → cache reload → lease-eligible → relay connect. Idempotent: a second install of the same fingerprint is a no-op; a failed install writes nothing; compensation: none needed (no file existed). | max-attempts: unbounded observe rounds, but cadence backs off 30 s → 5 min after 1 h (a declared long-running healer, constant per-round cost: one signed read per active sibling); requests ≤1 per 10 min, one in flight; dedupe-key: `agent-identity-missing:<agent>:<machineId>`; breaker: 4 consecutive FLEET refusals (`rate-limited` excluded) → escalate; flapping: 3 adopt→lose cycles in 24 h → `critical` ("this host keeps losing its identity file"); max-notification-latency: `120s`; audit-location: `logs/agent-identity.jsonl` (transitions + hourly heartbeat; fingerprints and machine ids only) | `high` item after 4 fleet refusals or 120 s; names the reason and the lever (§1.8); heal continues; resolves on success |
| **Identity split between machines** (§2.2/2.3/2.4) | `data-loss` (peers' messages to the agent are being queued and expired) | none automatic for an EXISTING split — the heal is the operator ceremony (§1.4), which the item links as a one-tap action; concurrently the comparison re-runs each tick so a ceremony or manual repair resolves the item without operator action | dedupe-key: `agent-identity-split:<agent>:<sorted fp set>`; confirm: `flagConfirmTicks` (2) consecutive `disagree` reads; resolve: lease holder only, after 2 consecutive full-set `agree`; cannot-tell never pages (but 10 consecutive → one `medium` item after a presence re-pull); max-notification-latency: immediate on confirmation (`≤60s`); audit-location: `logs/agent-identity.jsonl`, `logs/machine-coherence.jsonl` | immediate `high` on confirmation (data-loss class escalates on the same tick, heal-concurrent); resolves on confirmed `agree` |
| **Dark peer with queued sends** (§3, via `A2ARedeliverySentinel` escalate-only) | `recoverable` | on the AWAKE machine only: (1) if my relay is `disconnected`/`displaced`, `reconnectRelay()` (idempotent; the existing re-arm); (2) re-issue `discover` (read); (3) run the §2 self-check (read) — if I am the split one, that item supersedes this; on a standby: skipped with reason `standby` | max-attempts: 2 heal passes 40 s apart (≤ the 120 s ceiling); dedupe-key: `a2a-peer-dark:<agent>:<peerFp>:<episode>`; breaker: 4 dark↔alive flaps in 24 h → one "intermittent" item + doubled cooldown; aggregation: relay not connected or ≥2 peers crossing in one window → ONE aggregated item, per-peer suppressed; cooldown 12 h per peer; max-notification-latency: `120s` after the dark threshold; audit-location: `logs/a2a-peer-dark.jsonl` (peer fp, counts, timings; never bodies) | `medium` item after heal exhausted; resolves on first ack/inbound/`delivered` |
| **Held forward on a standby** (§4.2) | `recoverable` (the reply is durable; nothing is lost yet) | `lease-settling` re-reads (≤60 s, no row); in-process ladder 3×10 s re-resolving the holder; then re-forward the SAME operation on the recovery schedule; idempotent on the operation id (holder dedupes); compensation: an `outcome-unknown` attempt is never re-sent — it queries the old holder's status and stays held | max-attempts: 9 (existing), 15-min schedule, max-wall-clock 6 h (existing deadline); dedupe-key: `telegram-origin-held:<topic>`; breaker: 3 topics held on one standby within 1 h → one aggregated item; max-notification-latency: `120s` from `forward-to-holder-failed` (never from a settling window); audit-location: the origin store attempts rows + `logs/telegram-origin-held.jsonl` | user template via the holder at ≤120 s; `high` item when the holder cannot be reached for the notice; expiry recorded durably and re-raised once with honest wording |

The constitution's `standards.selfHealBeforeNotify.recoverableLatencyCeiling` key is not
present in `docs/STANDARDS-REGISTRY.md` at `e76caca6a`; per the standard a missing ceiling
fails closed, so every recoverable latency above is set to `120s` (escalate-sooner) rather
than to a longer value this spec would prefer.

## Evidence each check relies on (symbol → state)

| Check | Symbol read | State claimed | Independent corroboration | When unmeasurable |
|---|---|---|---|---|
| Joined-machine detection (§1.1) | `.instar/machines/registry.json` lists a row other than own `machine/identity.json` id | this agent already has an identity elsewhere | the §1.2 observe round — a registry sibling that answers with a signed fingerprint proves the state | no registry file → `not joined` → mint (audited); a registry present but unreadable → `joined` (fail closed, named) |
| Unanimity + last-known pin (§1.3) | each ACTIVE sibling's signed `agent-identity-observe` answer; this machine's last-known fingerprint from local durable files | the fleet publishes one identity, and it is the one this machine used | the sealed envelope's public key hashing to the same value under the serving machine's registry-pinned signature, plus the in-memory private↔public check — a sibling cannot serve a key it does not hold | any active sibling unreachable/unsigned/`no-handler` → `cannot-tell` → refuse; no local memory → the pin is skipped and the item says so |
| Divergence verdict (§2.2) | each machine's clamp-passed `coherenceAdvert.agentFingerprint` from the presence registry; own value from the on-disk file via the single reader | all copies of the identity are the same key | OUT of process: the relay's own view of the agent (`discover` self-lookup / registry row) and the recipient fingerprint on recent inbound envelopes (§2.4) — a unanimous-but-wrong fleet still disagrees with the network | advert absent/stale → `cannot-tell` for that peer, logged, never pages, never "agree"; 10 consecutive → one item |
| `dark` peer (§3.1) | ledger rows: oldest un-acked row newer than last ack/inbound; last ack; last inbound | the peer is not receiving | the relay's `recipientLastSeenAt` on the queued ack / `discover` presence; my own relay state (a disconnected sender makes every peer look queued — checked FIRST in the heal, on the awake machine) | ledger unreadable → `dark: unknown`, no item, degradation row; relay field absent → "unknown", never "never connected" |
| Standby forward outcome (§4) | the holder's receipt for the forwarded operation id | the reply was sent from the holder | the holder's origin record (`deliveryMachineId`, Telegram message id) via `/telegram/origins/:id`, and the `status` action on a holder change | no receipt within the timeout → `effect-unknown`, stays `held`, never replayed blind, never marked delivered |
| Never-served / never-backup (§5) | requested path + `realpath`; the `KEY_FILE_MANIFEST` | the file is not key material | the behavioural walk of a fixture home (0600 files / `privateKey` fields) — which can disagree with the manifest and the list | `realpath` fails → refuse; the walk finding an undenied key file → build failure |

## Frontloaded Decisions

1. **One comparison formula — the routing fingerprint (raw public-key prefix) — everywhere an
   agent identity is compared.** The sha256-based `canonicalId` is a trust-system id and is
   never compared to a routing value; envelopes carry a `fingerprintFormula` stamp for the
   transition. NOT cheap: it changes what the detector claims and what the pin verifies.
2. **Both mint sites are guarded by the same `detectJoinedMesh` predicate; an unreadable
   registry refuses; a joined machine with no identity boots unprovisioned AND
   lease-ineligible rather than minting.** NOT cheap (identity). The legacy-migration branch
   stays open; the mint-site census is an allowlist by file.
3. **Adoption fills a VOID and never replaces.** Void = no file at either path and
   `IdentityManager.get()` null; invalid, locked or encrypted files are never written over;
   replacement is the PIN-gated ceremony with a backup before rename and a signed replace
   mandate the target verifies. NOT cheap (identity).
4. **Adoption requires unanimity of ALL ACTIVE registered siblings (revoked rows excluded and
   named; `not-provisioned` responders excluded from the quorum; ≥1 provisioned responder),
   over SIGNED responses, cross-checked against this machine's last-known fingerprint.** Any
   gap refuses. NOT cheap (identity). A presence-window quorum was rejected (§1.3).
5. **The identity rides dedicated mesh verbs (`agent-identity-observe`, `-request`,
   `-replace`) with SIGNED responses, sealed with the existing `encryptForSync` to the
   requester's REGISTRY X25519 key, audited on both sides and announced once by the adopter.**
   NOT cheap (key custody). Reusing `secret-share` was rejected (unsigned responses; general
   sync set).
6. **The legacy `threadline/identity.json` is a mirror repaired at first load, with backup,
   and the listener daemon is reloaded after the repair.** NOT cheap (it is that daemon's
   primary key; a stale daemon could displace the server's relay connection). Backup name
   `threadline/identity.json.superseded-<ISO>`.
7. **The identity dimension is always loud and never suppressed by version skew; any machine
   raises, only the lease holder resolves; a split is `disagree` whenever any two observed
   values differ.** NOT cheap (user-visible alert semantics).
8. **Dark-peer reporting rides the EXISTING `A2ARedeliverySentinel` in escalate-only mode with
   a deterministic item id; it is signal-only, separate from resend.** The raw `peerDark` /
   `dark` FIELDS and their names are NOT cheap (a published interface — decided here: the names
   in §3.2); the thresholds (`queuedDarkAfterMs` 2 h, cooldown 12 h) and the dry-run gate on
   the notice AND the `deliveryOutcome` sentence are cheap-to-change-after: a wrong threshold
   costs a log row until the flip.
9. **A standby forwards its origin sends to the lease holder after a bounded `lease-settling`
   window and an in-process retry ladder; only a failed forward holds, durably, with a new
   `lease-not-held` reason, a notice through the holder, a `/health` degradation and one item;
   the holder's `submit` runs `authorize`.** NOT cheap (user-visible reachability). Code
   default `dryRun:false`; the builder sets `dryRun:true` on the dev agent, the run ends, and a
   48-h commitment flips it on a clean soak.
10. **Key material is denied by code-owned, config-immune lists (routes, backup, gitignore,
    classifier) checked on the resolved path, anchored on a `KEY_FILE_MANIFEST` at the single
    owner-only writer and a behavioural fixture walk.** NOT cheap (security surface); no flag.
11. **No relay-side retirement of the orphan `afd256bc…` / `ae6feac6…` rows.** Still the
    parent's Frontloaded Decision 5 / CMT-026 (relay authorization model). The additive
    `recipientLastSeenAt` field (§3.4) is a read, not a retirement.
12. **No per-device certificates / account-identity migration; no at-rest encryption change.**
    The shared-key bridge stays; "rotation is the only revocation" stands. Both are tracked
    (§Out of scope), not implied.
13. **Under `.instar/threadline/`, only the key-bearing files are never-served, not the
    directory.** NOT cheap (security surface), decided here.
14. **The dark-peer threshold defaults to 2 h, below the 6 h ACK-discipline window.** The
    sender is told before the ACK discipline would escalate; the value is config and the
    sentence + notice ship dry-run. Cheap-to-change-after (a threshold behind a dry-run flag).
15. **The operator is never notified before self-heal has run**: missing identity → adoption
    first (4 fleet refusals or 120 s); dark peer → fix-my-side first (awake machine only);
    held forward → settle + ladder + re-forward first. The identity SPLIT is the one
    `data-loss` class and escalates on confirmation with the ceremony as the concurrent
    heal. NOT cheap (notice semantics); the constitution's missing latency ceiling makes every
    recoverable value `120s`.
16. **Config placement and names, fixed here**: `messaging[].config.messageOrigin.forwardToHolder
    {enabled, dryRun}` (array-aware migration); `threadline.peerDarkNotice {dryRun,
    queuedDarkAfterMs, cooldownMs}` (dev-gated, `enabled` omitted, in `DEV_GATED_FEATURES`);
    `agentIdentity.adoption {enabled: true}` (top-level, FLEET-LIVE kill switch — NOT
    dev-gated, so not in the dev-gate registry). Attention item ids:
    `agent-identity-missing:<agent>:<machineId>`, `agent-identity-split:<agent>:<sorted fp set>`,
    `agent-identity-adopted:<agent>:<machineId>:<fp>`, `a2a-peer-dark:<agent>:<peerFp>:<episode>`,
    `telegram-origin-held:<topic>`. Priorities use the real enum (`low|medium|high|critical`).
    Pairing URL parameter `afp`. Plan id lifetime 15 min, single-use.
17. **Escape hatches are named, not implied** (§1.8): machine removal unblocks unanimity; a
    fleet with no candidate mints anew through the ceremony or the local `instar identity init
    --standalone` CLI; invalid files become ceremony candidates. NOT cheap (identity), decided
    here so no lockout exists.
18. **The relay gains an additive `recipientLastSeenAt` on queued acks.** The relay is this
    project's shared deployment; the field is optional, old clients ignore it, and absence is
    "unknown". Cheap-to-change-after: a read-only optional field on a verdict the sender
    already receives.

## Tests (Testing Integrity Standard — all three tiers; each acceptance criterion names its test)

**Acceptance criteria → tests**

| AC | Criterion | Test |
|---|---|---|
| AC1 | A joined machine with no identity never mints at boot and boots lease-ineligible | `agent-identity-mint-guard.test.ts` (unit); E2E boot test |
| AC2 | A standalone first machine still mints | `agent-identity-mint-guard.test.ts` |
| AC3 | An identity-less paired machine adopts the active fleet's unanimous identity over signed responses and connects as it; any gap refuses with the named reason | `agent-identity-adoption.test.ts` (unit); two-server integration |
| AC4 | Four machines holding the same key read `agree`; the 63b1/afd2 pair reads `disagree`; one unreachable member with two differing observed values reads `disagree` | `agent-identity-fingerprint-formula.test.ts` |
| AC5 | A unanimous fleet that the relay addresses differently raises the split item | `agent-identity-relay-corroboration.test.ts` |
| AC6 | The ceremony replaces an identity only with a verified mandate, backs up first, and a late machine applies the replicated record on boot | `agent-identity-ceremony.test.ts`; integration |
| AC7 | A standby's reply reaches the topic via the holder; a settling window never holds; a failed forward holds durably with `lease-not-held`, notice via holder, one item; retries never double-post | `telegram-origin-forward-on-standby.test.ts`; integration |
| AC8 | A dark peer yields one item through the existing sentinel; relay expiry does not clear `dark`; a local relay outage yields one aggregated item; a standby runs no heal | `a2a-peer-dark.test.ts` |
| AC9 | Every key-bearing file produced by a real init+pair is refused by `read`/`download`/`list`, excluded from backup, gitignored and secret-classified | `file-routes-key-census.test.ts` (static + behavioural) |

**Tier 1 — unit (`tests/unit/`)**
- `agent-identity-mint-guard.test.ts`: both mint sites refuse with an active, pending OR
  revoked sibling row; both mint with no registry file; an unreadable registry refuses (named);
  the legacy-migration branch still runs on a joined machine; the posture is lease-ineligible;
  the mint-site census passes the allowlist and fails on an injected unlisted
  `generateIdentityKeyPair(` site.
- `agent-identity-fingerprint-formula.test.ts`: `fingerprintOf(pub) === computeFingerprint(pub)
  === /provenance === /threadline/health` for one key; the sha256 form never equals any of
  them; `evaluateDivergence` with REAL keys (not opaque strings): four identical → `agree`;
  63b1/afd2 → `disagree`; two differing observed + one unreachable → `disagree`; one observed
  + rest unreachable → `cannot-tell`; the `fingerprintFormula` transition (sha256-form envelope
  against a self-pin accepted; against a routing pin refused).
- `agent-identity-adoption.test.ts`: unanimity → adopt; revoked rows excluded and named;
  `not-provisioned` responder excluded, ≥1 provisioned required; one unreachable → refuse;
  `no-handler` → refuse naming the sibling; one disagreeing → refuse; unsigned/mis-signed/
  nonce-mismatched answer → discarded as unverified; envelope key not hashing to the value →
  refuse; keypair-mismatch → nothing written; last-known-mismatch → refuse; serving side
  refuses a requester whose own observe answer carries a fingerprint, an unregistered sender,
  an `unknown-origin` self, a `fingerprint-mismatch`, and rate-limits with `retryAfterMs`;
  requester honours the window and `rate-limited` does not count toward the breaker; rotation
  to the next responder; the identity lock serializes a concurrent install; audit rows log
  transitions (not attempts) and contain fingerprints, never key bytes (byte-scan).
- `agent-identity-ceremony.test.ts`: plan renders candidates incl. superseded/invalid backups
  and the mint-new option; plan expires/single-use; commit without PIN → 401; a replace
  mandate with a wrong issuer, reused nonce, expired, or mismatched fingerprint is refused;
  a valid one backs up (`superseded-<ISO>`, 0600) before rename, reloads the cache,
  reconnects; the replicated record is applied on boot by a machine whose identity differs
  and is older; the reverse ceremony (choose the backup) restores it.
- `agent-identity-legacy-mirror.test.ts`: disagreeing legacy file rewritten from canonical
  with a backup under the lock; agreeing files untouched; a write failure leaves the old file
  and reports; a running listener daemon is signalled.
- `machine-coherence-identity-dimension.test.ts`: advert with/without the field; clamp
  whitelist AND the N5 reference advert carry it (byte figure asserted); `identity` row is
  `high`, not calm, survives version skew, confirms after N ticks, uses the shared item id;
  invalid hex → `unknown`, not `advert-rejected`; only the lease holder resolves.
- `agent-identity-relay-corroboration.test.ts`: unanimous fleet vs a differing relay row /
  inbound recipient → item with the named discrepancy; 10 consecutive `cannot-tell` → one
  `medium` item after a presence re-pull.
- `a2a-peer-dark.test.ts`: dark after 2 h with no ack/inbound; expiry does NOT clear it; an
  inbound/ack/delivered clears it; the existing sentinel in escalate-only mode raises one
  deterministic-id item; cooldown; flap → "intermittent"; ≥2 peers in one window / relay not
  connected → one aggregated item; standby heal skipped (`standby`) and never reconnects;
  dry-run writes would-raise + would-sentence rows and no item; wording for listed vs
  unlisted; names clamped/escaped; `allPeerHealth` bounded.
- `telegram-origin-forward-on-standby.test.ts`: `sendToTopic` forwards on standby-with-token;
  `willRelay()` mirrors it; `lease-settling` (holder confirms 20 s after boot → sent locally,
  no row, no notice, no item); ladder retries a `retryable` refusal 3×10 s re-resolving the
  holder; holder `submit` refuses `not-lease-holder`; `capabilities` cached per
  `(holder, leaseEpoch)`; failed forward → durable `held` + `hold_reason: lease-not-held`
  survives a service restart; recovery re-submits the SAME operation id, never re-prepares;
  holder change on `outcome-unknown` → status query, stays held, no double post; deadline →
  durable `expired-unresolved` with the honest wording; `destination-not-authorized` is never
  forwarded or notified; 3 topics in 1 h → one aggregated item; non-`sendMessage` methods from
  a standby → reported hold; single-machine no-op; older reader treats unknown `hold_reason`
  as `admitted`.
- `file-routes-never-served.test.ts`: every added prefix refused on `read`, `download`,
  `list`, `link` for the direct path, a symlink with an innocent name (entry-level realpath in
  `list`), a dangling symlink (refused), and a case-folded path; `PATCH /api/files/config`
  cannot remove them; allowed siblings (`conversations.json`) still serve.
- `file-routes-key-census.test.ts` (§5.4 static arm: manifest ⊆ every deny list; no
  owner-only write outside the manifest).

**Tier 2 — integration (`tests/integration/`)**
- Two in-process servers paired via the real `/mesh/rpc`: B boots with no identity and a
  registry naming A → B is lease-ineligible, observes (signed), adopts, connects to a stub relay
  as A's fingerprint, and the single `agent-identity-adopted` item exists; a third stub peer
  publishing a different fingerprint → B refuses and the item names both values; a stub peer
  answering `no-handler` → refuse naming it; a forged (unsigned) observe answer is ignored.
- Mixed-version pair: a new joiner against an old awake machine (sha256-form envelope, no
  `afp`) joins under the self-pin and then adopts via §1.7 once the awake machine updates.
- Ceremony end-to-end across two servers: plan → PIN commit on A → signed replace mandate →
  B backs up and installs → B's relay reconnects as the chosen fingerprint; the replicated
  record applied by a third server booted later with the old identity.
- Stub relay answering `queued` with a TTL and `recipientLastSeenAt`: after the threshold the
  send route carries `peerDark`, health shows `dark`, exactly one item exists (sentinel
  escalate-only); an inbound resolves it; a relay disconnect on the awake machine yields one
  aggregated item.
- Standby + holder pair with a Telegram stub: the standby's `/telegram/reply` lands via the
  holder with `forwardedFromMachine`; holder refuses `not-lease-holder` after a lease move and
  the ladder re-resolves; holder down → 409 `telegram-origin-held` `{hold_reason:
  lease-not-held}`, `/telegram/origins/status.held[]` lists it, `/health` carries the
  degradation; holder back → recovery delivers it once (same operation id).
- File routes + backup + classifier against a fixture agent home booted through the real
  init path and paired to a stub sibling (§5.4 behavioural arm): every 0600 / `privateKey`
  file refused, excluded, classified.

**Tier 3 — E2E lifecycle (`tests/e2e/`)**
- The production init path (mirroring `server.ts`): the routes exist and answer 200/409 (never
  503) — `/agent-identity/reconcile/plan`, `/agent-identity/audit` (+`?scope=pool`),
  `/threadline/peers/health` with the new fields, `/threadline/health.identityCoherence`
  populated after a presence tick, `/pool/machine-coherence` with the `identity` dimension
  when the guard is on; wiring-integrity: the forward dependency, the share/observe/replace
  handlers, the dark classifier wired into the sentinel, the identity lock, and the
  never-served/never-backup lists are real implementations, not null or no-ops.
- Migration E2E: an existing agent config gains the new defaults (including the array-aware
  origin block), the gitignore entries land, the CLAUDE.md template sections land once and are
  idempotent on a second run; a dev-agent config gets `dryRun:true` for the forward.

Live proof (Live-User-Channel Proof Before Done): before "done", a throwaway two-agent-home
pair on this Studio exercises adoption (incl. the asleep-sibling refusal and the one-tap
ceremony), the false-alarm regression (identical keys → `agree` on the real detector), a
forwarded Telegram reply into a proof room, and a Files-tab download attempt of
`.instar/identity.json` (expect 403) — recorded as the signed scenario matrix.

## Migration parity

- **Config defaults** (`ConfigDefaults.ts` → `migrateConfig` adds missing TOP-LEVEL keys
  only): `threadline.peerDarkNotice {dryRun:true, queuedDarkAfterMs, cooldownMs}` (no
  `enabled` key — dev-gate resolution), `agentIdentity.adoption {enabled:true}` (fleet-live
  kill switch for §1.2; §1.1's refusal has no switch — a joined machine minting is never
  correct). **Array-aware**: `messaging[].config.messageOrigin.forwardToHolder {enabled:true,
  dryRun:false}` added by extending `migrateTelegramOriginDisplay`.
- **Gitignore**: `.instar/identity.json*`, `.instar/threadline/identity.json*`,
  `.instar/threadline/*.key` added to `GITIGNORE_ENTRIES` + an idempotent `migrateGitignore`
  step.
- **CLAUDE.md template** (`generateClaudeMd()` + `migrateClaudeMd` with content-sniff guards):
  the "Agent awareness" bullets below.
- **Hooks / skills**: none.
- **Never-served / never-backup / classifier lists; `KEY_FILE_MANIFEST`**: code; no migration.
  **Dev-gate registry**: `threadline.peerDarkNotice` added to `DEV_GATED_FEATURES`
  (lint-enforced); `agentIdentity.adoption` is NOT dev-gated and is NOT registered there.
- **Relay**: the additive ack field ships with the next relay deploy; no client migration.
- **One-time boot repair**: §1.5's mirror repair, §1.6's provenance-root rewrite and §2.2's
  detector run at boot on every updated machine, so an agent already in today's "two
  disagreeing files" state heals on update without an explicit migration step.
- **Rolling update**: every new field/verb is tolerant of an older peer (§Multi-machine
  posture); adoption on a half-updated fleet refuses with the sibling to update named — never a
  wrong adoption, never a silent wait.
- **Idempotency**: every step above checks before writing; the E2E migration test runs twice.

## Rollback

- §1.1 guard: reverting re-opens silent minting on joined machines (the parent's rollback note
  applies: pair a revert with a freeze on joins or hand-provision). Adoption (§1.2–1.3) has a
  kill switch (`agentIdentity.adoption.enabled:false`); with it off a joined identity-less
  machine stays unprovisioned, lease-ineligible and loud, which is strictly better than
  minting. The local recovery CLI (§1.8) works regardless.
- §1.4 ceremony: a wrong choice is reversed through the same surface (the superseded backup
  is a candidate). Reverting the code leaves installed identities and backups in place.
- §2: reverting the formula restores the false alarm; reverting the dimension removes a row,
  never a guarantee that existed before.
- §3: flag off → raw fields still populated, no sentence, no notice (today's behaviour); the
  sentinel keeps its own `enabled:false` default.
- §4: `forwardToHolder.enabled:false` → today's local hold, now DURABLE and reported (the
  durable `held` state, the `lease-not-held` reason and the notice are not behind the flag —
  a silent hold is the defect).
- §5: no rollback lever by design; a false positive (an operator document under a denied
  prefix) is fixed by moving the document, not by serving keys.
- Nothing here deletes an identity file: superseded and invalid files are backed up beside the
  new one, owner-only, through the single writer.

## Agent awareness (CLAUDE.md template additions)

- **One identity across my machines**: a machine that joins or is rebuilt ADOPTS the agent
  identity from its siblings; it never invents one. If a machine reports
  `identity-not-provisioned`, read `GET /threadline/health` (`relay.state`,
  `identityCoherence`) and the `agent-identity-missing` attention item; adoption refuses unless
  every ACTIVE sibling signs the same value — say which sibling was unreachable, not yet
  updated, or disagreed, never guess. If a named sibling is decommissioned, remove it from the
  fleet (Machines tab) and adoption proceeds. Replacing an EXISTING identity is the operator's
  PIN ceremony on the Machines tab, never a file copy.
- **"Are my machines the same me on the agent network?"** → `GET /threadline/health →
  identityCoherence` on any machine (the fleet read); `GET /pool/machine-coherence` (identity
  row) where that guard is on. A split means peers' messages to me are being queued and lost;
  the item names the machine holding the relay under the wrong address and offers the one-tap
  ceremony.
- **"Did <peer> get my message?"** → the send response's `relayStatus` AND `peerDark`; a dark
  peer has had messages queued for hours with no acknowledgement — it may be offline or
  listening under a different address. `GET /threadline/peers/health` → `dark`, `darkSince`,
  `queuedCount`, `relayLastSeenAt`. Before blaming the peer, read my own `relay.state`.
- **"Why was my reply delayed / why did a topic go quiet on my other machine?"** → on a
  machine that does not hold the lease, replies are forwarded to the holder; a failed forward
  is a durable hold listed in `GET /telegram/origins/status` (`held[].hold_reason:
  lease-not-held`) with one attention item — never a silent drop.
- **Files tab**: identity, machine, SSH and HMAC key files are never served, listed, backed up
  or synced; a 403 on one of these is correct, not a bug to route around.

## Observability

- `logs/agent-identity.jsonl`: mint-refused (site, reason), adoption observe/request/refused
  (typed reason, fingerprint set; transitions + hourly heartbeat), mirror-repaired, ceremony
  plan/commit/replace, detector verdict transitions (agree/disagree/cannot-tell with per-peer
  reason), relay-corroboration discrepancies. Fingerprints only; never key bytes or sealed
  payloads (byte-scan test). Read: `GET /agent-identity/audit` (`?scope=pool`, `?limit`,
  `?since`).
- `GET /threadline/health`: `identityCoherence {state, connectedAs, siblingsPublish,
  relayPublishes, inboundAddressed, cannotTellRounds}`, `relay.state: 'not-provisioned'`.
- `GET /threadline/peers/health`: `dark`, `darkSince`, `queuedCount`, `relayLastSeenAt`;
  `logs/a2a-peer-dark.jsonl`.
- `GET /telegram/origins/status`: durable `held` with `hold_reason`, durable `expiredHolds`;
  `/health → telegramOrigin.heldForward`; `logs/telegram-origin-held.jsonl`.
- `GET /pool/machine-coherence`: the `identity` dimension and its episode.
- Attention item ids: per Frontloaded Decision 16.

## Out of scope (each with its carrier)

- Relay-side retirement of orphan registrations — CMT-026 (open).
- Rotation of the agent identity across the fleet / per-device certificates — the parent
  spec's accepted-cost boundary; now two incidents old; filed as an evolution action at build
  time (`agent-identity-rotation-and-device-certs`) with this spec as origin.
- The pool ownership-record divergence named in ACT-058 — ACT-058 itself remains open for that
  half (WS1.3 reconciler); §4 closes the reachability half.
- Encrypting the canonical private key at rest by default — filed as an evolution action at
  build time (`agent-identity-at-rest-passphrase`); the boot path passes no passphrase and a
  change needs its own operator ceremony.
- Teaching the relay to answer "never registered" — deliberately untracked: §3.4's
  `recipientLastSeenAt` is the honest bounded version, and "never" is unknowable to a relay
  with a bounded log.

## Open questions

*(none)* — every question the draft carried is resolved in Frontloaded Decisions 13–18.

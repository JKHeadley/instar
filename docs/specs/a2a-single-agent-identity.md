---
title: "A2A single agent identity — one identity across all machines, loudly checked, honestly reported"
slug: "a2a-single-agent-identity"
author: "echo"
status: "draft"
origin: "CMT-706 (Justin, Telegram topic 9210, 2026-10-09): 'Find a robust solution so agent identity mismatches are NEVER an issue for agent-to-agent communication.' Incident 2026-10-08 / ACT-058."
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
sibling-principles: "Verify the State, Not Its Symbol; No Silent Degradation; The Agent Is Always Reachable; Know Your Principal — An Unverified Identity Is a Guess; Structure > Willpower; Close the Loop; Self-Heal Before Notify; Bounded Notification Surface; Mobile-Complete Operator Actions"
parent-spec: "docs/specs/agent-identity-continuity-on-expansion.md"
related-specs: "docs/specs/machine-coherence-guard.md; docs/specs/a2a-cross-machine-route.md; docs/specs/cross-machine-secret-sync-spec.md; docs/specs/threadline-identity-single-writer.md; docs/specs/machine-self-assertion.md"
eli16-overview: "docs/specs/a2a-single-agent-identity.eli16.md"
lessons-engaged: "P3 (migration parity: array-aware origin block, deep-merged threadline block, explicit gitignore migration); P4 (three test tiers per AC); P7 (no new LLM loop — every decision point is tier0 by the Decision-points table); P19 (adoption loop declared an Eternal Sentinel with a 5-min floor); P20 (every detector declares symbol/state/corroboration/unmeasurable; the parent's fail-toward-minting is reversed with the least-harmful direction argued); P22 (claims are verified against the tree at e76caca6a, with file:line); L12 (superseded/invalid files are renamed, never unlinked); B2/B3 (the operator is never handed a command — the agent runs it after one yes)"
review-convergence: "pending"
approved: false
---

# A2A single agent identity

One agent, one identity, on every machine — and when that is not true, the agent says so
before a peer has to.

Five parts and no more (operator direction, 2026-10-09: 80/20, no over-engineering; the five
parts, including the ACT-058 reply hold, were named by the operator). Everything a reviewer
wanted beyond them is in §Out of scope with a carrier.

## Glossary (five lines)

- **Routing fingerprint** — the 32-hex address peers pin for me on the relay; one per agent.
- **Lease / serving-lease holder** — the one machine currently allowed to serve Telegram; the
  **awake** machine is the one polling Telegram and holding my single relay connection.
- **Item** — one entry on the Attention queue, deduped by id; raised, then resolved.
- **Posture** — a machine's declared mode (`identity-not-provisioned` here).
- **Dark** — a peer with messages queued for N h and nothing back; a proxy, not a cause.

## Problem

### The incident (2026-10-08)

Echo runs on four machines. Three publish routing fingerprint `63b1dbb2…`, the value every
peer has pinned since May. The Mac Studio had minted its own identity (`.instar/identity.json`,
2026-08-26, fingerprint `afd256bc…`) AND held the serving lease, so it held the agent's one
relay connection. Peers addressed `63b1dbb2…`, which nothing was connected as; the relay
answered `queued` (it queues for any unconnected fingerprint, 24 h) and silently expired each
message; the Studio sat connected as an address nobody had pinned. Dawn's messages from
2026-10-05 were lost; nothing on either side could tell "offline" from "never arriving". It
was fixed by hand on 2026-10-09 (the Mini's file copied onto the Studio). This is the SECOND
split of the same machine: the parent spec (`agent-identity-continuity-on-expansion.md`,
approved 2026-08-19) shipped a join-time carry on 2026-08-20; the Studio minted six days after.

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
   `/provenance` value, which is the raw public-key prefix (`src/server/routes/provenance.ts:69`)
   — the formula the relay, `/threadline/health` and every pinned peer use
   (`computeFingerprint`, `src/threadline/client/MessageEncryptor.ts:80-82`). Today, with all
   four machines REPAIRED, the server log says `[identity-divergence] SPLIT: 63b1dbb2… vs
   ff2e6980…`. A detector that fires identically on healthy and broken fleets is ignored,
   which is exactly what happened. It also runs once, 90 s after boot.
4. **The relay's `queued` is indistinguishable from "nobody will ever receive this".** The
   relay queues for any fingerprint not connected right now and tells the sender only a TTL.
   The sender's ledger (`A2ADeliveryTracker`) marks a peer `stale` after 6 h, but that is a
   read-only field. The one component that could speak — `A2ARedeliverySentinel`
   (`src/monitoring/A2ARedeliverySentinel.ts`) — is only constructed when
   `monitoring.a2aRedelivery.enabled` is true, which ships `false`.
5. **A reply from a machine that does not hold the lease is held forever, silently** (ACT-058,
   topic 122413, 2026-10-08). With the session pool on, a topic is legitimately owned by a
   standby. Its replies go through `TelegramOriginService`
   (`src/messaging/telegram-origin/`), whose `authorize` requires `holdsLease()`
   (`TelegramOriginBoot.ts:139`). The hold keeps the payload in a per-process map, never calls
   the store's existing `recordOperationState('held')`, is excluded from the outage notice,
   and is retried every 15 min by a non-lease-gated recovery tick — so the standby re-holds
   its own message nine times and drops it. The forward-to-holder primitive
   (`telegram.outboundRelay` → `relayOriginBot`) exists, but `TelegramAdapter.sendToTopic`
   (`:1392`, mirrored by `willRelay()` at `:663`) takes it only when the adapter has NO bot
   token.
6. **The Files tab hands out private keys.** `GET /api/files/download` (`fileRoutes.ts:859-907`)
   streams any project file that passes the code-owned `NEVER_SERVED_PREFIXES` and the
   config-editable `blockedFilenames`. Neither covers `.instar/identity.json` (the canonical
   Ed25519 private key, plaintext), `.instar/threadline/identity.json`, `.instar/machine-ssh/*`,
   `.instar/state/inbound-delivery.hmac-key`, `.instar/relay-tokens.json` or
   `.instar/local-state/keys.enc`. `isNeverServed` already runs on the resolved path for
   `read`/`download` (`fileRoutes.ts:245-268`), but `blockedFilenames` runs on the REQUESTED
   name (`:874`), `list` runs `blockedFilenames` per entry but not the never-served check
   (`:411`, `:484`) and `link` resolves nothing (`:926`). Any Bearer holder can download the
   agent's signing identity.

Every item is the same defect at a different layer: a symbol trusted in place of its state
(one mint site; one formula; "queued" read as "will arrive"; `admitted` as "will be sent";
"allowed path" as "safe to serve"). The parent's AC1/AC6/AC7/AC7b are unmet in code; §Tests
binds every criterion here to a named test.

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
  and peers pin. `threadline/agent-info.json` is rewritten UNCONDITIONALLY at every boot by
  `announcePresence` (`AgentDiscovery.ts:263-290`, atomic write), standby included, and the
  `fingerprint` field is OMITTED when no routing identity resolves
  (`ThreadlineBootstrap.ts:180-196`) — so a boot without an identity erases the last value.
  The listener daemon (`src/threadline/listener-daemon.ts:135`) loads the LEGACY path as its
  primary key file and handles only SIGTERM/SIGINT (`:295-302`, exit 0); the server's only
  lever over it is `POST /listener/restart` (`routes.ts:36057-36067`, SIGTERM only — the
  server never spawns it), the launchd plist `installListener` writes has
  `KeepAlive.SuccessfulExit=false` (`commands/listener.ts:450-456`, a clean exit is not
  relaunched), and `daemonHandlingRelay` is decided once at boot (`ThreadlineBootstrap.ts:242-275`).
- **Join-time carry** (parent §1, built): `POST /api/pair` seals the identity to the joiner's
  ephemeral X25519 key with `encryptForSync`; `installAgentIdentityFromPairing` writes
  atomically and never mints on failure. Envelope `identityFingerprint` is in the sha256 form.
- **Mint guard** (parent §2, built at ONE of two sites): `getOrCreate()` throws when
  `detectJoinedMesh()` (`src/threadline/client/JoinedMeshDetector.ts`) sees any registry row
  (status ignored). That predicate FAILS TOWARD MINTING by design: `registry-unreadable` and
  `no-machine-id` answer `joined: false` (`:24-28`, `:57-69`); it collapses ENOENT and EACCES
  into `no-registry` (`:56-63`) and `no-machine-id` with rows present still mints (`:82`).
- **Cross-machine secret sync**: `SecretSync.ts`, X25519+HKDF+AES-256-GCM per recipient
  (`SecretStore.encryptForSync/decryptFromSync`) sealed to the recipient's REGISTRY
  `encryptionPublicKey`; transport `POST /mesh/rpc` (requests Ed25519-signed by the sending
  machine, refused for non-active senders at `verifyEnvelope` via `isMachineActive`, nonce
  replay check; RESPONSES are not signed, `MeshRpcClient.ts:83-93`; LAN ropes are plain HTTP).
  `AccountCredentialShare.ts` establishes that credential-class payloads get their OWN verb.
- **Machine registry**: rows carry `status` (`active|revoked|pending`); `removeMachine` sets
  `revoked`; `isRegistryEntryActive(entry)` (`MachineIdentity.ts:147`) is the predicate.
  `instar machines remove` exists (`src/cli.ts:2145`); there is NO `instar identity` command.
- **A2A delivery ledger**: `A2ADeliveryTracker` (SQLite, `src/threadline/A2ADeliveryTracker.ts`):
  table `a2a_delivery` keyed on `peer_fp` only (no sender column, `:122-136`), per-message
  `state` (`awaiting-ack|acked|failed|escalated|unconfirmed`) and `relay_status`
  (delivered/queued+expires/rejected/expired), `peerHealth()` with `stale` at 6 h
  (`expiredNewer` rule), `sweepSilence`, `findOverdue()` (`:495`, `SELECT *` over every
  `awaiting-ack`/`unconfirmed` row). No `DELETE` anywhere: rows accumulate by design (`:556`).
- **Relay `discover`**: `RelayServer.handleDiscover` (`RelayServer.ts:1170-1200`) returns
  agents with `status: 'online'|'offline'`; the client's `knownAgents` presence map
  (`ThreadlineClient.ts:66-75`) is fed by `discover-result` (`:270`) and `presence-change`
  (`:274`, today only re-emitted) frames. `discover()` resolves `[]` on its 10 s timeout and on
  rate-limit (`:468-510`, 10/min, `RelayRateLimiter.ts:34`) but REJECTS `Not connected` with no
  relay client (`:473`, `:755`). `reconnectRelay()` (`:207-210`) reuses the `RelayClient` built
  with the identity loaded at construction (`:217`, `:231`) — it cannot pick up a new key.
- **A2A redelivery sentinel** (`src/monitoring/A2ARedeliverySentinel.ts`): per-MESSAGE
  (`findOverdue` → `markEscalated`, terminal; no resolve, cooldown or per-peer state); item id
  minted at `server.ts:19204`; constructed only when `monitoring.a2aRedelivery.enabled`
  (`server.ts:19180`), default `false`. A standby's relay is `disconnected` BY DESIGN (one
  connection per identity; a second displaces the first).
- **Telegram origin** (`src/messaging/telegram-origin/`): `TelegramOriginService` (admit →
  claim → authorize → execute); the durable store's `recordOperationState('held')` and
  `expireOperation` (`expired-unresolved`) are never called from the hold path; recovery
  schedule 15 min / 6 h / 9 attempts; `relayOriginBot` (signed `capabilities` + `submit`,
  `sendMessage` only); the holder-side `submit` (`OriginMesh.ts:111-125`) skips `authorize`.
- **Lease**: `LeaseCoordinator.holdsLease()` / `currentHolder()` (`LeaseCoordinator.ts:462`,
  returns `lease.holder` with NO expiry check) / `isHolderHealthy()` (`:475`); `holdsLease()`
  is `true` on a single machine; right after a respawn the eventual holder reads `false` for
  a few seconds.
- **Config shape**: Telegram-origin settings live in `messaging[].config.messageOrigin` and
  are migrated by the array-aware `migrateTelegramOriginDisplay`
  (`src/messaging/telegram-origin/OriginConfig.ts:30`). Nested `threadline.*` defaults reach
  existing agents through `applyDefaults` deep-merge (`src/config/ConfigDefaults.ts:2354-2402`);
  `migrateConfig` adds missing TOP-LEVEL keys only.
- **File routes**: `src/server/fileRoutes.ts` — `NEVER_SERVED_PREFIXES` (code-owned, prefix
  match), `blockedFilenames` (config-editable), routes `read`, `download`, `list` (capped at
  500 entries; skips entries it cannot `stat`, `:502-505`), `link`. `BackupManager`'s
  never-backup list is `BLOCKED_PATH_PREFIXES` (`BackupManager.ts:33`, stateDir-relative;
  `ORIGIN_LOCAL_BACKUP_PREFIXES` shows the two-spelling convention); `.instar/identity.json`
  is in neither, but IS already in the classifier's `DEFAULT_SECRET_PATTERNS`
  (`FileClassifier.ts:203`). `GITIGNORE_ENTRIES` (`MachineIdentity.ts:913`) feeds `init` only;
  `migrateGitignore` (`PostUpdateMigrator.ts:13264`) adds entries one by one via
  `addGitignoreEntry`. `.instar/origin-sessions-*` is already gitignored and backup-excluded.
- **Migration**: `PostUpdateMigrator.migrate()`; `migrateGitignore`, `migrateClaudeMd` exist;
  dev-gated flags must be registered in `src/core/devGatedFeatures.ts` (`DEV_GATED_FEATURES`,
  read by `scripts/lint-dev-agent-dark-gate.js`); `scripts/lint-machine-local-justification.js`
  validates posture markers.
- **Acting on another machine**: `POST /sessions/spawn` is local-only (`routes.ts:11165`); peer
  SSH is fleet-dark; an idle machine has zero sessions. The one real primitive is
  `POST /pool/transfer {topic, to}` (`routes.ts:21181`, consent-gated; 409 offline; 503 when
  the pool is dark), after which the conversation's session runs ON that machine.
- **`a2a-cross-machine-route`** forwards a standby's A2A sends to the relay holder; §4 is its
  Telegram-origin sibling (attested origin payload, the serving-lease holder, `relayOriginBot`,
  its own durable hold) — they share the signed mesh RPC transport and nothing else.

## Threat model

- **A hostile or compromised sibling requests the agent identity.** The request must be
  signed by a REGISTERED ACTIVE machine key; the payload is sealed to that machine's REGISTRY
  encryption key (never a key named in the body); one share per requester per 10 min; both
  sides audit. Not mitigated, stated plainly: a legitimate sibling already holds the same
  private key (the parent spec's accepted "compatibility bridge"); rotation remains the only
  revocation (§Out of scope). **Bridge budget:** this spec adds adoption, operator adoption and
  the mirror repair on top of that bridge — every one of them exists for routing continuity
  only; no feature may come to DEPEND on the shared key for anything else, and rotation /
  per-device certificates stay the intended end state.
- **A fabricated identity is pushed to a machine with none.** Mesh RESPONSES are unsigned
  today and LAN ropes are plain HTTP. Mitigated: the two new verbs' responses are signed by
  the responder's registry-pinned machine key over `{fingerprint, requesterNonce}`; the
  requester verifies before counting an observation or opening an envelope; private↔public
  correspondence is checked in memory before the write; with no local memory of its own
  address a machine needs two independent signed witnesses (§1.3).
- **A wrong "canonical" is auto-written over a working identity.** Not possible by
  construction: adoption fills a VOID only; replacement is a command on that machine (§1.4)
  after a human yes, with a backup. A mesh-callable "replace my key" verb and a signed
  key-less "adopt from X" TRIGGER verb were both rejected: each lets a compromised but
  still-active sibling make a healthy machine replace its good key. The lever is not
  reachable over the network; the only Bearer route added, `POST /agent-identity/reload`,
  re-reads this machine's OWN disk and can install nothing.
- **A detector that pages on healthy fleets; a notice flood when a peer goes dark or MY relay
  is down.** Mitigated by §2 (one formula, a semantic `agree` test, a resolve rule a sleeping
  sibling cannot starve) and §3 (one item per peer per episode; one aggregated item when my
  relay is down; dry-run first).
- **The forward-to-holder path double-posts or loops.** Mitigated: the holder's `submit` runs
  `authorize`; a forwarded operation keeps its ORIGINAL operation id so the holder dedupes;
  an `outcome-unknown` forward is never re-sent blind; the standby never also executes locally.
- **Key material leaves via a read surface.** Mitigated by §5: a code-owned, config-immune
  deny list checked on the opened file (not just the resolved path) in
  `read`/`download`/`list`/`link`, mirrored into backup, gitignore and the secret classifier,
  with a fixture walk that can disagree with it.

## Design

### 1. One identity, adopted from siblings — never minted on a joined machine

**1.1 Close the second mint site.** `detectJoinedMesh` gains a third verdict,
`unreadable` (a registry file exists but cannot be read or parsed — ENOENT and EACCES are
split, today both collapse to `no-registry`), and BOTH mint sites — `createUnifiedTrustSystem`'s
`create()` call (new guard; its legacy-migration branch is untouched) and `getOrCreate()`
(existing guard) — refuse on `joined` AND on `unreadable`. Readings: no registry file →
standalone first machine → mint as today; a registry naming any other row (any status) →
refuse; a registry with rows but no own machine id → refuse (today it mints); unreadable →
refuse. The
parent let an unreadable registry fall toward minting so a filesystem fault could not brick a
standalone agent; the least-harmful direction (P20) is reversed here because a registry file's
EXISTENCE is itself pairing evidence (a standalone first machine has none), and minting there
is exactly how a rebuilt sibling recreates the split. The one case this costs — a
single-machine agent with no identity AND a corrupt registry — boots loud, and the lever
(§1.4 `init --standalone`) is named in the item. A present-but-unloadable (invalid or
encrypted) file boots the same posture; adoption refuses `identity-file-invalid` every round
(it never writes over a file) and the item names `instar identity adopt --from <sibling>`.

A refused mint boots the server in `identity-not-provisioned` posture: the relay connection
is not attempted (`/threadline/health → relay.state: 'not-provisioned'`, `fingerprint`
absent); the machine **yields the lease ONLY to a live provisioned peer**: it is
lease-ineligible (declines to acquire; releases at the next tick) iff at least one ACTIVE
sibling is presence-online AND answered `provisioned` in the latest observe round — an
unprovisioned holder would take the WHOLE fleet off the network. Otherwise (lone machine,
all revoked, `unreadable`, or the only sibling asleep) it acquires/holds as today and keeps
serving Telegram, scheduler and live-tail unprovisioned — a paired-then-shrunk machine still runs a real
`LeaseCoordinator` (`MultiMachineCoordinator.ts:397-405`, `server.ts:5451`), and declining
there would hold every reply, including the item asking for the fix, behind
`TelegramOriginBoot.authorize` (The Agent Is Always Reachable); `DegradationReporter` writes
the row on the same tick; the adoption loop (§1.2) starts immediately. The operator sees ONE
`high` attention item `agent-identity-missing:<agent>:<machineId>` only after adoption has
been refused for a fleet reason on 4 consecutive rounds or 120 s have passed — whichever
first — naming the reason and the lever. Adoption keeps retrying; the item resolves itself on
success. A machine whose installed identity file later disappears (a reload that finds no
file) re-enters this posture and counts one adopt→lose cycle. In this posture
`announcePresence` does NOT rewrite `threadline/agent-info.json` (today it would write it
with no `fingerprint`, erasing the one memory §1.3 pins on); the file keeps the last value
this machine actually published.

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
  registry-pinned machine Ed25519 key; the responder's own value is read from its ON-DISK
  file through the single reader, never the in-process cache (the same rule §2.2 uses — a
  file moved aside by the CLI must read as `not-provisioned` on a running server). An
  unsigned, mis-signed or nonce-mismatched answer is discarded as unreachable. An older
  sibling answers `no-handler` = unreachable, named in the item ("update <nick>").
- **Request** (write): `agent-identity-request` `{agentName, expectedFingerprint,
  requesterNonce}` to ONE sibling that published the value, rotating on a typed refusal,
  never more than once per 10 min, one in flight. Serving refusals, each typed:
  `not-registered`, `no-usable-identity`, `fingerprint-mismatch`, `requester-publishes-identity`
  (the server reads the requester's own observe answer back first — the one void-check it
  can do), `rate-limited` (`retryAfterMs`). A refusal is signed over `{reason, requesterNonce}`
  exactly like an answer; an unsigned or mis-signed refusal, like `no-handler`, counts as
  `unreachable` — a LAN peer cannot spoof a refusal to stall or steer adoption. Payload: the
  identity sealed to the requester's REGISTRY `encryptionPublicKey` with an AAD-bound variant
  of `encryptForSync` (own HKDF info string; AAD = `{verb, requesterMachineId, requesterNonce,
  fingerprint}`, fail closed on mismatch — the plain primitive is forbidden for credential
  payloads by `SecretStore.ts:597-610`, and a blob sealed with it would be interchangeable
  with a secret-sync blob); the signed envelope `{sealed, fingerprint,
  requesterNonce, adoptedFrom: {machineId, at}}`.
- Acceptance (§1.3), then install through `installAgentIdentityFromPairing`'s atomic
  owner-only write after verifying private↔public correspondence IN MEMORY (`keypair-mismatch`
  writes nothing). Then the **reload lever** runs: `IdentityManager` re-reads disk (the cache
  is invalidated, not reused), the `RelayClient` is REBUILT with the new key (today's
  `reconnectRelay()` reuses the client built at construction and cannot change identity),
  lease-ineligibility lifts, and the bootstrap's standby + daemon predicate is RE-RUN before
  any connect (a standby stays `disconnected` by design — a rebuilt machine is usually a
  standby, and a connect from it would displace the awake machine); the awake machine
  connects on the next tick — no server restart. The same lever is exposed as Bearer
  `POST /agent-identity/reload` (local effect only: re-read this machine's own disk, rebuild
  its relay client, answer the resulting fingerprint; carries no key; single-flight with a
  60 s per-machine cooldown, `429`) so the CLI (§1.4) and the mirror repair (§1.5) share it.
- **The identity lock.** Identity mutations on a machine are serialized by
  `.instar/identity.lock` (O_EXCL, pid-stamped), shared by adoption, the CLI (§1.4), the
  mirror repair (§1.5) and `instar join`. The lock stamps pid + process start time; it is
  stale when that pair no longer matches a live process AND it is older than 60 s, or after a
  10-min ceiling regardless (pids are reused); a stale lock is broken by renaming it to a unique name (only one breaker's
  rename succeeds), after which creation goes through O_EXCL again — two processes can never
  both hold it. A waiter retries for 30 s, then refuses `identity-locked`.
- Audit: both sides append to `logs/agent-identity.jsonl` on every reason TRANSITION plus an
  hourly heartbeat while refused (fingerprints, machine ids, the observed set `k of n
  active` and the adoption MODE — `one-witness+pin` or `two-witnesses`; NEVER key material).
  The adopting machine raises ONE `medium` item
  `agent-identity-adopted:<agent>:<machineId>:<fp>` on success, whose body states the mode
  and how many active siblings were observed, worded "this proves agreement among the
  machines I could reach, not correctness" — a key copy is an event the operator must be
  able to see.
- A joiner that completes `instar join` WITHOUT an envelope (old awake machine) boots in the
  same posture and adopts the same way, instead of today's "update and re-pair".

**1.3 Which identity to adopt: `reachable-agree`, pinned by local memory, else refuse.** Adopt
only when, in one observe round, all of the following hold:

- every REACHABLE sibling whose registry row is ACTIVE and who answered `provisioned` with a
  VERIFIED signature published the same fingerprint (`not-provisioned` responders — another
  rebuilt machine — are excluded, not counted as disagreement);
- the number of such witnesses is at least ONE when this machine remembers its own address,
  and at least TWO when it does not — the last-known pin is read from
  `threadline/agent-info.json` only (rewritten at every boot in the routing formula; the
  ledger has no sender column and a superseded backup is by construction a key this machine
  stopped using), and when it is present the envelope's fingerprint must equal it
  (`last-known-mismatch` refuses); a single witness with no local memory refuses
  `single-witness` and the item names it;
- the sealed envelope's public key hashes (routing formula) to exactly that value.

Any disagreement, verification failure, single-witness or last-known mismatch → refuse, stay
unprovisioned, keep the item open naming the observed set (`k of n active`). A
`last-known-mismatch` item says it plainly: "this machine's own memory (X) disagrees with
what its siblings publish (Y); if THIS machine was the split one, the fix is to adopt from a
sibling" — because `agent-info.json` on a formerly-split machine remembers the split value,
and an operator who deleted the bad key expecting self-heal must not read the refusal as a
fleet problem. An UNREACHABLE
sibling does not block (the Laptop and the Mama PC are asleep most hours; a rule that waits
for all of them makes the alert the normal path for every rebuilt machine). The accepted
cost, stated: a machine whose reachable witnesses (two, or one plus its own memory) are ALL
split adopts the split value — a state §2 is already loud about, with §1.4 as the fix. Revoked rows are
excluded and named in the refusal when they are the only siblings. The parent spec rejected
peer MAJORITY for choosing BETWEEN candidates; this rule fills a void with the one value the
reachable fleet signs for, and `reachable-agree` is the exact term used in items and audit so
it is never read as fleet-wide agreement.

**1.4 Replacing an existing identity: a command on that machine, run by me after a human
yes.** `decideReconciliation` and the dashboard ceremony are NOT wired (§Out of scope). A NEW
CLI command group `instar identity` (`src/commands/identity.ts`, beside `machine.ts`), always
run ON the affected machine:

- `instar identity adopt --from <machine-name-or-id>` — under the lock, FIRST moves the
  existing identity file to `identity.json.superseded-<ISO>` AND `threadline/agent-info.json`
  to `agent-info.json.superseded-<ISO>` (owner-only, single writer) so this machine's observe
  answer reads `not-provisioned` and its stale memory cannot pin; THEN requests the identity
  from the named sibling through `agent-identity-request`; verifies signature,
  sealed-key-hashes-to-value and the in-memory keypair check — WITHOUT the `reachable-agree`
  and last-known rules (the human named the source, and this machine's memory is precisely
  what is being corrected); installs; calls the reload lever (§1.2) on the running server
  (`POST /agent-identity/reload`, or nothing if no server is up — the next boot loads the new
  file); restarts a running listener daemon via the CLI's own `restartListener` (stop + start,
  the one real restart that exists). ANY refusal or failure restores BOTH moved files and
  says so; a crash in between leaves the backups on disk and the machine in the loud
  `identity-not-provisioned` posture, and a re-run of `adopt` proceeds as a void-fill when
  there is no file to move. Provenance `adopted-by-operator`. This replaces the 2026-10-09
  manual file copy, which left disagreeing files and no backup. A present-but-invalid or
  encrypted file is moved aside as `identity.json.invalid-<ISO>` by this command only.
- `instar identity init --standalone --i-understand-peers-must-repin` — mints a NEW identity
  on a fleet with no usable candidate (provenance `minted-by-operator-recovery`).
- A decommissioned sibling that answers nothing is removed with `instar machines remove`
  (existing) — which, with this spec, prints and the §2.2 item repeats the parent's required
  notice: "<name> is revoked for the mesh but still holds a copy of the agent identity and can
  sign as <agent> until the identity is rotated fleet-wide" — today it says "can no longer
  authenticate" (`machine.ts:283`), true of the machine key, false of the agent key.

**Who runs it.** I do, not the operator (a terminal command is never the user's chore). The
§2 item says "I can fix this: say yes and I will adopt the identity <sibling> publishes onto
<nick>". Replacing a live key is irreversible in effect (peers' queued messages are not backed
up), so the floor is one human approval. On the yes, the HONEST path to a shell on the named
machine is the existing one: I move the conversation (the topic the yes arrived in) there with
`POST /pool/transfer {topic, to: <nick>}` (the yes is the consent), the resumed session runs
the command, I report the outcome in one line, then `POST /pool/unpin {topic}`. An offline
target answers 409 and the item stays open saying so (an offline machine holds no relay, so
peers are not hurt until it wakes). There is no session of mine on an idle peer, no peer-SSH
on the fleet, no network verb (§Threat model) — the transfer IS the mechanism. Where the pool
is dark (`/pool/transfer` → 503, the fleet default) the yes is recorded durably ON the item
and the named machine runs `identity adopt --from <sibling>` from its own first session the
next time it boots or holds the lease; the item says "nothing to do now". Mobile-complete by
a reply, no dashboard surface. The `init --standalone` case is the same shape.

**1.5 The legacy file is a mirror, repaired at first load.** When `IdentityManager.loadFromDisk()`
finds both files and they disagree, the canonical one wins (as today) AND the legacy file is
rewritten to match — by the single writer, under the lock, atomically, old file backed up as
`threadline/identity.json.superseded-<ISO>` — with ONE degradation row. The listener daemon
loads the legacy path as ITS key and the server's only lever over it is a SIGTERM (a clean
exit is not relaunched by launchd). So: (a) the daemon drops its legacy-first manager and
loads the CANONICAL file first (`listener-daemon.ts:135`), so any future start is correct;
(b) when a repair happens while a daemon is alive under the superseded key, the server
SIGTERMs it and re-runs its own `daemonHandlingRelay` decision, taking the relay connection
itself — a relaunched daemon loads the right key and takes it back as at every boot today; a
daemon that is not running is left alone. Today's manual fix left exactly this state and the
server logs an `[identity]` ERROR at every boot.

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

- the formula fix. SELF contributes TWO values: the on-disk file read through the single
  reader AND the fingerprint the running relay client is connected as (`connectedAs`); a
  difference between them is itself `disagree` (a file repaired while the process still
  speaks under the old key — the incident state — must never read as healthy);
- it runs every 5 min (not once), with an in-flight guard; peers are read as today
  (Bearer `fetch(<peerUrl>/provenance)`, 8 s timeout, one request per active sibling —
  roughly a tenth of the 30 s presence pull's cost). A peer whose pool-registry `online` flag
  (written by `PeerPresencePuller`, not the active-machine list) reads OFFLINE is
  `unobserved` for the round (not fetched, not counted) — an asleep machine
  is a known state, not a failure to observe;
- the health field `identityCoherence.state`: `disagree` whenever ANY two observed values
  differ (an unreachable member never hides a demonstrated split); `agree` only when every
  ACTIVE sibling was observed and all match; `partial-agree` when ≥2 values were observed,
  all match, and some active sibling was unobserved — it stays visible on the health read
  until every active sibling has been observed once since the last repair; `cannot-tell`
  when fewer than two values were observed;
- item id `agent-identity-split:<agent>:<sorted fingerprint set>`, priority `high`, RAISED AND
  RESOLVED by the serving-lease holder only (attention items are a per-machine store with
  local id dedupe, `TelegramAdapter.ts:524,4047`, and the cross-machine ack ships dark — a
  raise elsewhere would strand a copy and post N hub messages; a non-holder's `disagree` is a
  health state, not a raise), after 2 consecutive `disagree` reads; resolved
  after 2 consecutive rounds in which (i) every machine that contributed a differing value to
  the item's set AND whose registry row is still ACTIVE has been re-observed, and (ii) the
  round holds exactly ONE value. A sibling that was never part of the split and is asleep
  does NOT block resolution (the same asymmetry §1.3 applies to adoption; without it a
  repaired fleet would carry an open `high` item until all four machines were awake
  together); the required set is carried on the item as `metadata.contributors {machineId:
  fp}` = machines whose LAST OBSERVED value ≠ the round's single value; a split member that
  was revoked (`instar machines remove`) AND is offline by presence drops out of the
  required set, and the item body names that lever for a decommissioned member. If a member
  is re-observed still differing, the item stays. A machine unobserved during the episode
  that later publishes a THIRD value is caught by the next tick as a new `disagree` with a
  different sorted set — a new item, never a silent gap. Body: "my machines are not the same
  me on the agent network — <nick> publishes X, the others publish Y; messages addressed to Y
  are lost while <nick> holds the relay. I can fix this: say yes and I will adopt the
  identity <sibling> publishes onto <nick>." The proposed TARGET is each machine publishing
  the minority value, the SOURCE any machine publishing the strict majority; with no strict
  majority (1-vs-1, 2-vs-2) NO direction is proposed — the item lists each value with its
  machines and the relay holder, and asks which address peers have pinned; `adopt --from`
  takes the machine the operator names. It resolves itself after the repair;
- `cannot-tell` rounds are counted per peer ONLY while that peer's presence says ONLINE (an
  online peer that does not answer `/provenance` is the anomaly; an asleep one is not); 10
  consecutive such rounds, after a self-heal (re-pull that peer's presence), produce one
  degradation row and ONE `medium` item "identity check cannot run against <nick>" — a split
  must not hide behind a slow peer forever, and a sleeping peer must never page;
- `/threadline/health` reports `identityCoherence: {state, connectedAs, siblingsPublish,
  cannotTellRounds, lastCheckedAt}` on every machine.

### 3. Honest sender-side reporting of a send that stays queued

**3.1 Classification.** `A2ADeliveryTracker.peerHealth()` gains `dark` and `darkSince`: a peer
is `dark` when its oldest row that is `awaiting-ack` (relay `queued`), `unconfirmed`, or
`failed`+`expired` — and NEWER than the last ack and last inbound from that peer — is older
than `queuedDarkAfterMs` (default 2 h, below the 6 h `stale` window so the sender hears first).
A peer leaves `dark` ONLY on an ack, an inbound, or a `delivered` verdict (the existing
`expiredNewer` shape; relay expiry alone never clears it, so a persistently dark peer is one
episode, not one per day). `dark` is a PROXY read from my own ledger: it means "nothing from
this peer for N h", and it cannot by itself tell offline from wrong-address — the data model
carries no cause, only the duration, and the wording says so. `allPeerHealth` is bounded to
peers active in the last 30 days (a narrowing of a published read, decided here). Retention:
the existing `sweepSilence` tick gains one statement deleting rows with `sent_at` older than
30 days in EVERY state, enumerated (`acked`/`failed`/`escalated`/`unconfirmed`/`awaiting-ack`
— including a `delivered`-but-never-acked row, which has no relay expiry and which the
reworked sentinel no longer terminalizes) on the existing `(state, sent_at)` index, and
`findOverdue` gains `ORDER BY sent_at ASC LIMIT 500`, so the sentinel's scan and
`allPeerHealth`'s distinct-peer scan are bounded. This is consistent with `dark`: a peer silent for 30 days has
already left `allPeerHealth`, and its `dark` state is re-established by the next send.

**3.2 Where it is said.**

- **In the send response.** `POST /threadline/relay-send` (and the `threadline_send` tool
  result, additive) answers a send to a dark peer with `peerDark: {since, queuedCount,
  expiresAt, connectedNow}`, computed from THIS machine's ledger and presence map only (the
  pool-scope merge belongs to the sentinel and the health reads — never a peer fan-out inside
  a send). `connectedNow` is read from the client's EXISTING `knownAgents`
  presence map — fed today by `discover-result` frames and, with this spec, also by the
  `presence-change` frames the relay already pushes (today only re-emitted) — never from an
  inline `discover` on the send path (a slow relay must not cost a reply 10 s, and discovery
  is rate-limited; no new relay calls are added). Values: `true` when the peer's row has
  `online === true`, `false` when its row says `offline`, `null` when there is no row, when
  my relay is not `connected`, or when no discover/presence frame has arrived since the last
  sentinel tick (15 min). A refresh that REJECTS (`Not connected` — no relay client, the
  standby case) yields an empty snapshot → `null`; on a standby every send is forwarded, so
  the relay holder computes the field. The
  `deliveryOutcome` SENTENCE branches on it — "no acknowledgement from <peer> for N h; this
  and K other messages are still queued (oldest expires T)" + one of "<peer> is not connected
  to the relay right now — it may be offline, or listening under a different address" /
  "<peer> IS connected to the relay but has not acknowledged anything — it may be listening
  under a different address, or not reading" / "whether <peer> is connected right now is
  unknown" — worded to the evidence (never "nothing will arrive") and riding the dry-run flag.
  Peer names render as fingerprint prefix + clamped, HTML-escaped display name — in the
  sentence AND in every attention item body (§2.2, §3.2); relay-supplied free text never
  reaches an item my sessions read.
- **On the health read.** `GET /threadline/peers/health` and the per-peer route carry `dark`,
  `darkSince`, `queuedCount`, `connectedNow`; pool scope merges as today.
- **To the operator, once — through the REWORKED sentinel.** `A2ARedeliverySentinel` is today
  per-message with no resolve, cooldown or per-peer state, so it is reworked rather than
  re-triggered: (i) it is constructed when EITHER `monitoring.a2aRedelivery.enabled` OR the
  resolved `threadline.peerDarkNotice` gate is on (today only the former), with
  `redeliver` undefined when only the latter is (escalate-only); (ii) its trigger becomes
  per-peer `dark && queuedCount > 0 && selfHealExhausted`, where `dark` for the RAISE is
  computed over the SAME pool-scope ack/inbound the resolve reads (a peer that answered on my
  other machine is not dark, even if my own rows never got their ack); (iii) the item id,
  minted where it is today (`server.ts:19204`), becomes the deterministic
  `a2a-peer-dark:<agent>:<peerFp>` (no episode stamp — rows live on whichever machine carried
  the send, and a lease move would otherwise strand one machine's item forever); (iv) it
  RESOLVES — on EVERY machine over its OWN item store, awake or not (the heal stays
  awake-only) — from pool-scope `peers/health` (any machine's ack, inbound or `delivered`
  verdict from that peer newer
  than the item's raise time), its resolve line names the count of messages that were never
  acknowledged and have expired ("<peer> is back; N messages from the dark window expired
  unacknowledged — resend what still matters"), and it carries a per-peer cooldown of 12 h.
  Accepted cost, stated: a peer that goes dark again INSIDE the cooldown is reported only
  when the cooldown lapses; the health fields show it immediately. A message already
  `escalated` by the old per-message path never suppresses a later `dark` episode. Body:
  "Messages to <peer> are stuck: K queued since T, none acknowledged. <peer> may be offline,
  or listening under a different address."
- **Aggregation when the cause is local.** If my own relay is not `connected`, ONE aggregated
  item ("relay unreachable from this machine; K peers, M messages queued") and per-peer items
  are suppressed until it is back.

**3.3 The self-heal, and where it may run.** Before blaming the peer, fix my side — ONLY on the
awake (telegram-polling) machine, because a standby's relay is `disconnected` by design and
reconnecting it would displace the live holder: (1) if my relay is `disconnected`/`displaced`,
`reconnectRelay()` (idempotent, the existing re-arm); (2) refresh the presence map with one
`discover` (a rejected call — no relay client — leaves the map empty, `connectedNow: null`);
(3) run the §2 self-check — if I am the split one, that item supersedes this. On a standby
the heal is skipped with reason `standby`. Two passes 40 s apart inside the 120 s ceiling.

**3.4 Rollout.** `threadline.peerDarkNotice: {dryRun: true, queuedDarkAfterMs: 7200000,
cooldownMs: 43200000}`, `enabled` OMITTED (dev-gate; in `DEV_GATED_FEATURES`); delivered by
the `ConfigDefaults` deep-merge. Dry-run logs would-raise/would-sentence rows to
`logs/a2a-peer-dark.jsonl`; the raw health fields are live from the first build (reads), but
no item and no sentence until the flip.

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
  false (the seconds after a respawn), or `!isHolderHealthy(currentHolder())` (a named but
  expired holder — `currentHolder()` has no expiry check of its own), re-read the lease with
  backoff for ≤15 s BEFORE writing anything (this runs inside the reply request; the holder
  reads `false` for a few seconds, not a minute — a slower move is the ladder's job). Settles
  to self → send locally; to a healthy peer → forward. No row, no notice. A window that does
  NOT settle in 15 s (a dead holder whose lease has not yet expired) is treated as
  `forward-to-holder-failed`: the durable hold, then the ladder. Settling reads the in-memory
  lease view and calls `pullFromPeers()` at most ONCE — never repeated pulls in a request.
- **Request budget, then the ladder.** The reply request runs settle (≤15 s) plus ONE forward
  attempt with a per-attempt budget of 30 s (≥ the holder's 10 s execute + 5 s margin; the
  two RPCs `capabilities`+`submit` share it) — under the route's 120 s timeout, so a caller
  never times out before the hold is written and re-runs with a NEW operation id (the one
  double-post the holder's dedupe cannot catch). It answers 200 on a local send or confirmed
  forward, 409 `telegram-origin-held {hold_reason}` the moment the attempt fails. The
  remaining attempts run from the recovery tick: a TYPED refusal that proves non-admission
  (`not-lease-holder`, `rate-limited`, `execution-owner-mismatch` before admit) is retried
  2× more at +10 s and +20 s, re-resolving the holder each time, then the 15-min schedule. A
  transport timeout is NEVER retryable: it is `outcome-unknown`, and the next step is the
  existing `receipt` RPC to the SAME holder for that operation id.
- **Durable hold.** Only `forward-to-holder-failed` holds: the EXISTING
  `recordOperationState('held')` is called with a new `hold_reason` = `lease-not-held` —
  distinct from `destination-not-authorized`, which keeps meaning "foreign chat" and is never
  forwarded or notified. The in-memory held map becomes a cache of the store; an older reader
  treats an unknown `hold_reason` as `admitted` (additive).
- **Recovery re-forwards the SAME operation** (original operation id and sealed record; the
  holder dedupes) while the holder is unchanged. A record is attested with
  `executionOwnerMachineId` = the holder that was read, and the holder-side `submit` refuses a
  record owned by another machine BEFORE `authorize` (`execution-owner-mismatch`, kept — the
  receipt dedupe depends on it). So on a holder change, recovery FIRST asks the OLD owner's
  `receipt`: `not-admitted`/no record → the old operation is durably SUPERSEDED (new state,
  linked by operation id, which lifts the relay's unresolved-operation guard) and a NEW record
  bound to the new owner is prepared and forwarded; sent → done; old owner unreachable →
  stays held `effect-unknown` until it answers or the deadline passes — never a blind re-send.
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
and the notice are NOT behind the flag; a silent hold is the defect). An agent with no machine
identity is a strict no-op (`holdsLease()` is true only with no lease coordinator attached;
a paired-then-shrunk machine runs one). The pool ownership-record divergence also
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
under `.instar/threadline/` are denied (`conversations.json`, `trust-profiles.json` and thread
history are the operator's own audit surfaces). Config-immune: `PATCH /api/files/config` can
narrow `allowedPaths` but never remove an entry. Exact-path access control, not a meaning
filter (Signal vs. Authority does not apply to an enumerated floor).

**5.2 Check the file that is actually opened.** `read`/`download` already run the never-served
check on the `realpath` (`fileRoutes.ts:245-268`); the gaps are `blockedFilenames` (requested
name only), `list` (no per-entry check) and `link` (no resolution). Closed as: `blockedFilenames`
and the never-served check run on BOTH the requested and the resolved path in all four routes;
`list` resolves EACH entry and OMITS one whose realpath fails or is denied (a symlink with an
innocent name is hidden, not listed; the route's existing skip-on-stat-failure shape); `link`
resolves before minting. Against the check-then-serve race (a symlink swapped between the
check and the stream), `read`/`download` open the file FIRST, refuse unless the opened
descriptor's `fstat` device+inode equals `stat` of the checked resolved path, and then read
or stream FROM THAT DESCRIPTOR (`createReadStream(…, {fd})` / `fd.readFile`) — today both
routes re-open by path (`:570`, `:897`), which would reintroduce the race. A file whose
`fstat` reports `nlink > 1` is refused when its device+inode equals that of ANY never-served
file (the listed key files are `stat`ed per request — a dozen calls): a hard link OUTSIDE
`.instar/` carries a key's inode under an innocent name, and no prefix check can see it. A
`realpath` failure in `read`/`download`/`link` refuses.

**5.3 The same list guards the other read surfaces.** The same prefixes are added, in both
spellings the list uses (`identity.json` and `.instar/identity.json`), to `BackupManager`'s
`BLOCKED_PATH_PREFIXES` (an operator adding `identity.json` to `backup.includeFiles` must not
ship the key in a snapshot — stated cost: a lone machine's only identity recovery is then
`init --standalone` + peer re-pins); to `GITIGNORE_ENTRIES` for new agents AND as explicit
`addGitignoreEntry` calls in `migrateGitignore` for existing ones (both repos); and to the
classifier's `DEFAULT_SECRET_PATTERNS` as prefixes (`.instar/identity.json` is there today as
an exact match, so its backups are not; the other files are absent).

**5.4 A walk that can disagree with the list.** One behavioural test boots a fixture agent home
through the real init path, pairs it to a stub sibling so every key-bearing file is produced,
walks `.instar/` for files with mode 0600, JSON carrying a `privateKey`/`secretKey` field, or a
name matching `*.key`, `*.secret`, `*hmac*`, `*.enc`, `*token*`, and asserts each is refused by
`read`/`download`/`list`/`link`, excluded from backup, gitignored and secret-classified. A new
key file the list does not cover fails the build.

**5.5 No flag.** A security floor; ships live; one release-note line names what the Files tab stops serving.

## Decision points touched

| Decision point | Change | Classification |
|---|---|---|
| Both mint sites (`createUnifiedTrustSystem`, `getOrCreate`) | refuse on `joined` and on the new `unreadable` verdict; boot `identity-not-provisioned` | invariant — an on-disk fact decides; no competing signal; the human lever is §1.4 |
| `identity-not-provisioned` → yield the lease only to a live provisioned peer | new | invariant — presence-online + signed `provisioned` in the latest observe round; a lone machine or one whose sibling sleeps keeps the operator's Telegram |
| `agent-identity-request` serving refusals | new | invariant — deterministic predicates on local state or a signed read; the verb hands out a private key, so no judgment may widen it |
| Adoption acceptance (§1.3: `reachable-agree`, witness floor 1-with-memory / 2-without, last-known pin) | new | invariant — deliberately: choosing an identity is the irreversible act this spec exists to stop being guessed; the only other path is §1.4 after a human yes |
| `instar identity adopt` replace | new; run by the agent after one human approval | invariant — the human is the arbiter (rung 1 floor); the command itself only verifies signature + key correspondence |
| Split-repair proposal (§2.2: target = minority value, source = strict majority; no majority → no proposal) | new | invariant — a count over published values; the human is the arbiter and the agent never guesses a direction |
| Legacy mirror rewrite (§1.5) | new automatic write | invariant — the parent's rule (canonical wins), backup before rewrite, no competing signal beyond the two files |
| Identity-divergence verdict and item raise/resolve | changed: one formula, every 5 min; self = disk AND `connectedAs`; raise on any two differing values; resolve when every still-active split member is re-observed and the round holds one value | invariant — equality of published fingerprints; an offline peer is `unobserved`, `cannot-tell` on insufficient observation never pages |
| Per-peer `dark` classification (§3.1) | new signal | invariant — a time threshold over ledger rows; signal-only; thresholds are config |
| `a2a-peer-dark` raise (reworked sentinel) | per-peer trigger over pool-scope acks + deterministic id + pool-scope resolve | invariant — raise iff `dark && queuedCount>0 && selfHealExhausted`; wording carries honest uncertainty |
| `sendToTopic` / `willRelay()` | modified: also forward when the pool is on and `!holdsLease()`, after `lease-settling` | invariant — the existing deterministic lease reads plus `isHolderHealthy` |
| Holder `submit` handler | new `authorize` check → typed `not-lease-holder` | invariant — the same predicate the direct path runs |
| Origin hold reasons | `lease-not-held` (new; forwardable, notifiable) vs `destination-not-authorized` (unchanged; never forwarded) | invariant — two facts, two reasons |
| File-route never-served list + opened-file check | new denials in `read`/`download`/`list`/`link` (incl. a hard link to a key inode anywhere), backup, gitignore, classifier | invariant — a code-owned path list; security floor; exact-path access control |
| `POST /agent-identity/reload` | new Bearer route | invariant — re-reads this machine's own disk and rebuilds its relay client; carries no key; installs nothing |

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
- **`logs/agent-identity.jsonl`, `.instar/identity.lock`, `threadline/agent-info.json` (the
  last-known pin) and `*.superseded-*` backups** — facts about the key copy on this disk.
  - machine-local-justification: physical-credential-locality impossible-because="this-disk-holds-the-key-copy-and-the-relay-connection-it-signs-under-relocating-it-is-the-split" permanence=permanent
  - mitigation: `GET /agent-identity/audit` (Bearer, read-only; `?scope=pool` merges online
    machines' rows tagged by machineId, dark-peer tolerant; `?limit` default 200).
- **Divergence verdict / `identityCoherence`** — every machine computes it; the item is
  raised and resolved on the lease holder only; the read is per machine on `/threadline/health`.
- **A2A delivery ledger + `dark`** — proxied-on-read: rows live on the machine that carried
  the send (the relay holder); `GET /threadline/peers/health?scope=pool` merges (existing),
  and each machine resolves its own copy of the item from that merged read so a lease move
  cannot strand it. The item is raised by the awake machine (the only one whose heal may run).
  - machine-local-justification: physical-credential-locality impossible-because="this-disk-holds-the-key-copy-and-the-relay-connection-it-signs-under-relocating-it-is-the-split" permanence=permanent
  - mitigation: the pool-scope read above (rows follow the relay connection on this disk).
- **Telegram origin held operation on a standby** — attested under this machine's signing key.
  - machine-local-justification: physical-credential-locality impossible-because="this-disk-holds-the-key-copy-and-the-relay-connection-it-signs-under-relocating-it-is-the-split" permanence=permanent
  - mitigation: readable
  from the pool via `/telegram/origins/status?scope=pool` (existing); the design moves the
  WORK (the forward) to the holder, not the record.
- **Relay connection** — unchanged: one per agent identity, on the awake machine
  (`physical-credential-locality`, pre-existing, not introduced here).
- **Never-served / never-backup / gitignore / classifier lists** — identical code on every
  machine; `unified` by construction.
- Rolling update: a sibling answering `no-handler` to a new verb is unreachable for adoption
  and named; an older peer's `/provenance` still answers the (now matching) routing formula.

## Watchers, self-heal and escalation (Self-Heal Before Notify)

| Watcher | Class | Self-heal + remediation-actions | Brakes | Escalation |
|---|---|---|---|---|
| **Missing identity on a joined machine** (§1.1) — a declared Eternal Sentinel (P19): healer-only, constant per-round cost, escalates once | `recoverable` | adoption: signed observe → `reachable-agree` + witness floor + last-known pin → one signed request → in-memory keypair check → atomic install under the lock → cache reload → lease-eligible → relay connect. Idempotent (a second install of the same fingerprint is a no-op; a failed install writes nothing); no compensation needed (no file existed). | observe cadence 30 s, backing off to a 5-min floor after 1 h (one signed read per active sibling per round); requests ≤1 per 10 min, one in flight; dedupe-key `agent-identity-missing:<agent>:<machineId>`; breaker: 4 consecutive FLEET refusals (`rate-limited` excluded) → escalate; flapping: 3 adopt→lose cycles in 24 h → `critical`; max-notification-latency `120s`; audit `logs/agent-identity.jsonl` | `high` item after 4 fleet refusals or 120 s; names reason + lever; heal continues; resolves on success |
| **Identity split between machines** (§2.2) | `data-loss` (peers' messages are queued and expired) | none automatic for an EXISTING split — the heal is my `instar identity adopt` on the named machine after the operator's yes; the comparison re-runs every 5 min so the repair resolves the item without further action | dedupe-key `agent-identity-split:<agent>:<sorted fp set>`; confirm 2 consecutive `disagree`; resolve: lease holder only, after 2 consecutive rounds re-observing every still-active split member with one value in the round (a non-member asleep never blocks; a revoked member drops out); cannot-tell never pages (10 consecutive → one `medium` item after a presence re-pull); max-notification-latency immediate on confirmation (`≤10min`, the cadence); audit `logs/agent-identity.jsonl` | immediate `high` on confirmation (data-loss class: notify-and-heal); resolves on the re-observed repair |
| **Dark peer with queued sends** (§3, reworked `A2ARedeliverySentinel`) | `recoverable` | on the AWAKE machine only: (1) relay `disconnected`/`displaced` → `reconnectRelay()` (idempotent); (2) refresh the `discover` snapshot; (3) run the §2 self-check (if I am the split one, that item supersedes); standby: skipped, reason `standby` | raise + resolve both read pool-scope acks; 2 heal passes 40 s apart (≤120 s); dedupe-key `a2a-peer-dark:<agent>:<peerFp>`; cooldown 12 h per peer; aggregation: relay not connected → ONE item, per-peer suppressed; max-notification-latency `120s` after the dark threshold; audit `logs/a2a-peer-dark.jsonl` (fp, counts, timings; never bodies) | `medium` item after heal exhausted; resolves on the first ack/inbound/`delivered` seen pool-wide |
| **Held forward on a standby** (§4.2) | `recoverable` (the reply is durable) | `lease-settling` re-reads (≤15 s, no row); ladder 3×10 s re-resolving the holder; then re-forward the SAME operation on the recovery schedule; idempotent on the operation id (holder dedupes); an `outcome-unknown` attempt is never re-sent — it queries the old holder's status and stays held | max-attempts 9, 15-min schedule, max-wall-clock 6 h (existing); dedupe-key `telegram-origin-held:<topic>`; breaker: 3 topics held on one standby in 1 h → one aggregated item; max-notification-latency `120s` from `forward-to-holder-failed` (never from settling); audit: origin store attempt rows + `logs/telegram-origin-held.jsonl` | user template via the holder at ≤120 s; `high` item when the holder cannot be reached for the notice; expiry recorded durably and re-raised once |

`standards.selfHealBeforeNotify.recoverableLatencyCeiling` is not present in
`docs/STANDARDS-REGISTRY.md` at `e76caca6a`; a missing ceiling fails closed, so every
recoverable latency above is `120s`.

## Evidence each check relies on (symbol → state)

| Check | Symbol read | State claimed | Independent corroboration | When unmeasurable |
|---|---|---|---|---|
| Joined-machine detection (§1.1) | `.instar/machines/registry.json` lists a row other than own id | this agent already has an identity elsewhere | the §1.2 observe round — a sibling answering with a signed fingerprint proves it | no registry file → mint (audited); registry present but unreadable → `unreadable` → refuse (fail closed, named) |
| Adoption acceptance (§1.3) | each reachable ACTIVE sibling's signed observe answer; this machine's last-known fingerprint from `threadline/agent-info.json` | the fleet publishes one identity, and it is the one this machine used | the sealed envelope's public key hashing to the same value under the serving machine's registry-pinned signature, plus the in-memory private↔public check — a sibling cannot serve a key it does not hold; with no local memory, a SECOND independent signed witness | no sibling reachable/signed → refuse (`cannot-tell`); one witness and no memory → refuse (`single-witness`); both named in the item |
| Divergence verdict (§2.2) | each ONLINE sibling's `/provenance` fingerprint; own on-disk value via the single reader AND the relay client's `connectedAs` | all copies of the identity are the same key | a peer's own report (its §3 dark-peer notice on their side) is the out-of-process check this spec relies on — stated, not implied (§Out of scope names the relay-side corroboration) | peer offline by presence → `unobserved`; online but unanswering → `cannot-tell` for that peer, never `agree`; ≥2 observed and matching with some unobserved → `partial-agree`, never `agree`; 10 consecutive cannot-tell (online only) → one item |
| `dark` peer (§3.1) | ledger rows across the pool: oldest un-acked row newer than the last ack/inbound from that peer on ANY machine | the peer is not receiving | the presence map's `online` field (`connectedNow`) and my own relay state (a disconnected sender makes every peer look queued — checked FIRST in the heal) | ledger unreadable → `dark: unknown`, no item, degradation row; no row / relay not connected / no frame since the last tick → `connectedNow: null`, never "never connected" |
| Standby forward outcome (§4) | the holder's receipt for the forwarded operation id | the reply was sent from the holder | the holder's origin record (`deliveryMachineId`, Telegram message id) via `/telegram/origins/:id`; the `status` action on a holder change | no receipt within the timeout → `effect-unknown`, stays `held`, never replayed blind, never marked delivered |
| Never-served (§5) | requested path + `realpath` + the opened descriptor's device+inode and link count | the file served is not key material | the behavioural fixture walk (0600 files / `privateKey` fields / secret-shaped names) — which can disagree with the list | `realpath` fails or `fstat` ≠ `stat` → refuse; the walk finding an undenied key file → build failure |

## Frontloaded Decisions

1. **One comparison formula — the routing fingerprint — everywhere an agent identity is
   compared.** NOT cheap (it changes what the detector claims). A join envelope is accepted
   under either formula during the transition.
2. **Both mint sites use `detectJoinedMesh`, which gains an `unreadable` verdict that both
   refuse on; a joined machine with no identity boots unprovisioned AND lease-ineligible.** NOT
   cheap (identity). The parent's fail-toward-minting direction is reversed and justified in
   §1.1. The mint-site census is an allowlist by file.
3. **Adoption fills a VOID and never replaces.** Invalid, locked or encrypted files are never
   written over; replacement is §1.4 with a backup before rename. NOT cheap (identity).
4. **Adoption needs `reachable-agree` — every reachable active `provisioned` sibling agrees,
   signed — with a witness floor of ONE when `threadline/agent-info.json` remembers this
   machine's address (and the value must match it) and TWO when it does not; an unreachable
   sibling does not block.** NOT cheap (identity). Waiting for ALL active siblings was
   rejected because two of this fleet's machines are asleep most hours; the accepted cost is
   stated in §1.3.
5. **The identity rides two dedicated signed mesh verbs, sealed with the existing
   an AAD-bound `encryptForSync` variant to the requester's REGISTRY X25519 key, audited both sides, announced once
   by the adopter.** NOT cheap (key custody). `secret-share` rejected (unsigned responses).
6. **No dashboard ceremony, replace mandate, replicated commit record, mesh-callable replace
   or signed trigger verb.** Replacement and fleet recovery are the NEW `instar identity adopt
   --from <machine>` / `init --standalone`, run on that machine by MY session after one human
   yes — reached by `POST /pool/transfer` (409 offline → item stays open; 503 pool-dark → the
   recorded yes drives the repair from that machine's next session). `adopt` moves the old
   identity file AND `agent-info.json` aside, restores both on failure, reloads, restarts a
   live listener, and skips the `reachable-agree` and last-known rules. NOT cheap (identity).
7. **The legacy `threadline/identity.json` is a mirror repaired at first load, with backup;
   the listener daemon loads the canonical file FIRST (legacy fallback); a daemon alive under
   the superseded key is SIGTERMed and the server takes the relay itself by re-running its
   `daemonHandlingRelay` decision.** NOT cheap (that daemon's key). A `POST /agent-identity/reload`
   Bearer route (local effect only) is the one reload lever shared by adoption, the CLI and
   the mirror repair; `announcePresence` never rewrites `agent-info.json` while unprovisioned.
8. **The detector stays on its existing `/provenance` read, every 5 min; self contributes
   disk AND `connectedAs`; an offline-by-presence peer is `unobserved` and never counts as
   `cannot-tell`; the lease holder raises and resolves when every still-active split
   member is re-observed and the round holds one value; `agree` stays strict and
   `partial-agree` is a distinct health state that persists until every active sibling has
   been seen once since the repair.** NOT cheap (alert semantics). The coherence-advert field / MachineCoherence `identity` dimension was cut
   (§Out of scope): three requests every five minutes do not justify new advert plumbing.
9. **Dark-peer reporting rides the REWORKED `A2ARedeliverySentinel` (constructed when either
   gate is on; per-peer trigger and resolve both over pool-scope acks; id
   `a2a-peer-dark:<agent>:<peerFp>`; resolve line names the expired-unacknowledged count);
   `connectedNow` comes from the client's existing `knownAgents` presence map fed by
   `discover-result` and `presence-change` frames (stale = relay not connected or no frame
   since the last 15-min tick), never a new relay field or an inline call; `allPeerHealth` is
   bounded to 30 days and ledger rows in every state are deleted after 30 days.** The field NAMES, the 30-day constants and the id are NOT cheap
   (published interface). The thresholds (`queuedDarkAfterMs` 2 h, cooldown 12 h) and the
   dry-run gate on the sentence AND notice are cheap-to-change-after: the threshold changes
   the live `dark` read at once, but no item and no sentence until the flip.
10. **A standby forwards its origin sends (`sendMessage` only in v1; media, edits and pins
    hold durably and are reported) to the lease holder after a ≤15 s `lease-settling` window
    that also treats an unhealthy named holder as unsettled (and an unsettled window as
    `forward-to-holder-failed`), then a 3×10 s ladder; only a
    failed forward holds, durably, with `lease-not-held`, a notice through the holder, a
    `/health` degradation and one item; the holder's `submit` runs `authorize`.** NOT cheap
    (reachability). Ships live with a kill switch, no dry-run.
11. **Key material is denied by code-owned, config-immune lists (routes, backup, gitignore,
    classifier) checked on the requested path, the resolved path AND the opened descriptor
    (served from that descriptor; a hard link to a key inode refused anywhere), with one behavioural
    fixture walk (mode, JSON fields and secret-shaped names).** NOT cheap
    (security surface); no flag. The static `KEY_FILE_MANIFEST` ratchet was cut (§Out of
    scope): the walk is the arm that can disagree with the list.
12. **Under `.instar/threadline/`, only the key-bearing files are never-served.** NOT cheap.
13. **The operator is never notified before self-heal has run** (missing identity → adoption
    first; dark peer → fix-my-side first; held forward → settle + ladder + re-forward first);
    the identity SPLIT is the one `data-loss` class and escalates on confirmation. NOT cheap.
14. **Config placement and names**: `messaging[].config.messageOrigin.forwardToHolder
    {enabled}` (array-aware migration); `threadline.peerDarkNotice {dryRun, queuedDarkAfterMs,
    cooldownMs}` (dev-gated, in `DEV_GATED_FEATURES`, delivered by the `ConfigDefaults`
    deep-merge); `agentIdentity.adoption {enabled: true}` (top-level, FLEET-LIVE kill switch,
    not dev-gated). Lock file `.instar/identity.lock` (pid+start-time stale rule, 10-min
    ceiling, rename-to-unique break, 30 s wait). Item ids and refusal reason names as in
    §1.2–§1.4; priorities from the real enum. `DEV_GATED_FEATURES` entry `configPath:
    'threadline.peerDarkNotice.enabled'`. NOT cheap (published names).
15. **No relay change** (no `recipientLastSeenAt`, no orphan retirement — CMT-026). NOT cheap.

## Tests (Testing Integrity Standard — all three tiers)

| AC | Criterion | Test |
|---|---|---|
| AC1 | A joined machine with no identity never mints at boot and boots lease-ineligible; a standalone first machine still mints; an unreadable registry refuses at BOTH sites; with no live provisioned sibling (lone, all-revoked, unreadable, or the sibling asleep) the machine keeps the lease, answers `/telegram/reply`, processes inbound, and its item reaches Telegram (loud, lever named); a present-but-invalid file boots unprovisioned and refuses `identity-file-invalid` | `agent-identity-mint-guard.test.ts` (unit); E2E boot |
| AC2 | An identity-less paired machine adopts the `reachable-agree` identity over signed responses and connects as it; one witness with local memory adopts, INCLUDING across a server restart in the unprovisioned posture (the memory survives); one witness without memory refuses `single-witness`; two witnesses without memory adopt; a disagreement, forged answer, keypair mismatch or last-known mismatch refuses with the named reason, and the last-known item names the adopt-from-a-sibling path | `agent-identity-adoption.test.ts` (unit); two-server integration |
| AC3 | Four machines holding the same key read `agree`; the 63b1/afd2 pair reads `disagree`; a disk value that differs from `connectedAs` reads `disagree`; one unreachable member with two differing observed values reads `disagree`; an offline-by-presence peer is `unobserved` and never increments `cannot-tell`; the item is raised once and resolved by the lease holder after the split member is re-observed repaired while a non-member sleeps, and a revoked member drops out of the required set | `agent-identity-fingerprint-formula.test.ts` |
| AC4 | `instar identity adopt --from` moves the identity file and `agent-info.json` aside, is NOT refused by `requester-publishes-identity` (the observe handler reads disk) or the last-known pin, installs, reloads via `POST /agent-identity/reload` (the relay client is rebuilt — `connectedAs` changes without a server restart; on a standby the lever never connects; a second call inside 60 s answers 429), and restores both files on a refusal; a re-run after a crash proceeds as a void-fill; `init --standalone` mints with the recovery provenance; with the pool dark the recorded yes drives the repair from the named machine's next session; `machines remove` prints the still-signs notice; a disagreeing legacy mirror is repaired with a backup, the daemon loads canonical first, and a daemon alive under the old key is stopped while the server takes the relay | `agent-identity-operator-cli.test.ts`; `agent-identity-legacy-mirror.test.ts` |
| AC5 | A dark peer yields one item through the reworked sentinel, which is constructed under the `peerDarkNotice` gate alone; relay expiry does not clear `dark`; an ack received on ANOTHER machine clears it (raise and resolve both pool-scope) and the resolve line names the expired count; an `escalated` message does not suppress a later episode; a local relay outage yields one aggregated item; a standby runs no heal; `connectedNow` is true/false/null from the presence map (a `presence-change` frame updates it; a rejected refresh yields null) and `discover` is never called inline; rows in every state older than 30 days are swept, including a `delivered`-unacked row; `peerDark` on a send reads only the local ledger | `a2a-peer-dark.test.ts` |
| AC6 | A standby's reply reaches the topic via the holder; a settling window never holds, an expired named holder counts as unsettled, and a window that never settles becomes a forward failure (hold, then ladder from the recovery tick); the reply request answers within settle + one 30 s attempt; a lease move mid-forward supersedes the old record and lands once via the new holder; a failed forward holds durably with `lease-not-held`, notice via holder, one item; retries never double-post; `destination-not-authorized` is never forwarded | `telegram-origin-forward-on-standby.test.ts`; integration |
| AC7 | Every key-bearing file produced by a real init+pair is refused by `read`/`download`/`list`/`link` (direct path, symlink, dangling symlink omitted from `list`, descriptor swapped after the check, a hard link OUTSIDE `.instar/` to a key file), and an allowed file is streamed from the checked descriptor, excluded from backup, gitignored (new AND migrated agent) and secret-classified; `PATCH /api/files/config` cannot remove a never-served entry; `conversations.json` still serves | `file-routes-never-served.test.ts` (static + behavioural walk) |

**Tier 1 — unit (`tests/unit/`)**: the seven files above, with REAL keys (never opaque
strings): `fingerprintOf(pub) === computeFingerprint(pub) === /provenance` and the sha256 form
never equals them; every §1.2–1.3 acceptance and serving refusal by name (unsigned refusal =
unreachable); the lock serializes a concurrent install and two stale-breakers cannot both
win; audit rows never contain key bytes (byte-scan); the mint-site census fails on an injected
unlisted `generateIdentityKeyPair(` site.

**Tier 2 — integration (`tests/integration/`)**: two in-process servers paired over the real
`/mesh/rpc` — B boots with no identity and a registry naming A, yields the lease, observes
(signed), adopts, connects to a stub relay as A's fingerprint, one `agent-identity-adopted` item
exists; a stub peer publishing a different fingerprint → B refuses, the item names both; a
forged answer is ignored. Stub relay `queued` + a `discover` row `offline`: after the threshold
the send route carries `peerDark`, health shows `dark`, exactly one item; an inbound on the
OTHER machine resolves it. Standby + holder with a Telegram stub: the standby's reply lands via
the holder; `not-lease-holder` after a lease move → the old record is superseded and the reply
lands ONCE via the new holder; holder down → 409 `telegram-origin-held {lease-not-held}`, listed
in `/telegram/origins/status.held[]`; holder back → delivered once. File routes + backup +
classifier against a fixture home booted through the real init path and paired to a stub.

**Tier 3 — E2E (`tests/e2e/`)**: the production init path — `/agent-identity/audit`
(+`?scope=pool`), `/threadline/peers/health` with the new fields,
`/threadline/health.identityCoherence` populated after the first check, answer 200 (never 503);
wiring-integrity: the forward dependency, the observe/request handlers, the reworked sentinel's
construction under the new gate, the identity lock and the never-served lists are real
implementations. Migration E2E: an existing config gains the new defaults (incl. the
array-aware origin block and the deep-merged `threadline` block), the gitignore entries land
via `migrateGitignore`, the CLAUDE.md sections land once and are idempotent.

Live proof (Live-User-Channel Proof Before Done): a throwaway two-agent-home pair on this
Studio exercises adoption (incl. the `single-witness` refusal and `identity adopt --from`
driven by transferring the proof conversation to the target home and running it there), the false-alarm regression (identical keys
→ `agree` on the real detector), a forwarded Telegram reply into a proof room, and a Files-tab
download of `.instar/identity.json` (expect 403).

## Migration parity

- **Config defaults**: `agentIdentity.adoption {enabled:true}` (top-level → `migrateConfig`);
  `threadline.peerDarkNotice {dryRun:true, queuedDarkAfterMs, cooldownMs}` (nested → the
  `ConfigDefaults` deep-merge; no `enabled` key). **Array-aware**:
  `messaging[].config.messageOrigin.forwardToHolder {enabled:true}` via
  `migrateTelegramOriginDisplay`.
- **Gitignore**: the §5.1 prefixes in `GITIGNORE_ENTRIES` (init) AND explicit
  `addGitignoreEntry` calls in `migrateGitignore` (update), both repos, idempotent.
- **CLAUDE.md template** (`generateClaudeMd()` + `migrateClaudeMd` content-sniff): §Agent
  awareness below. **Hooks / skills**: none. **Dev-gate registry**: `threadline.peerDarkNotice`
  in `src/core/devGatedFeatures.ts` (`configPath: 'threadline.peerDarkNotice.enabled'`).
- **Listener daemon**: the canonical-first key load (§1.5) applies to every daemon start after
  update; no migration step — a daemon already running under the legacy key is handled by the
  boot repair.
- **One-time boot repair**: §1.5 mirror repair, §2.1 provenance-root rewrite and §2.2's first
  check run at boot on every updated machine, so today's "two disagreeing files" state heals on
  update.
- **Rolling update**: every new verb/field tolerates an older peer (§Multi-machine posture).
- **Idempotency**: every step checks before writing; the E2E migration test runs twice.

## Rollback

- §1.1: reverting re-opens silent minting. Adoption's kill switch
  (`agentIdentity.adoption.enabled:false`) leaves a joined identity-less machine unprovisioned,
  lease-ineligible and loud — strictly better than minting; the CLI (§1.4) works regardless.
- §1.4: a wrong `identity adopt` is reversed by a second one from the right machine, or by
  restoring the superseded backup; nothing ever deletes an identity file.
- §2: reverting the formula restores the false alarm; nothing else to unwind.
- §3: flag off → raw fields still populated, no sentence, no notice; the sentinel rework
  itself (per-peer, deterministic id) is reversible by code revert only.
- §4: `forwardToHolder.enabled:false` → today's local hold, now DURABLE and reported.
- §5: no lever by design; a false positive is fixed by moving the document, not by serving keys.

## Agent awareness (CLAUDE.md template additions)

- **One identity across my machines**: a machine that joins or is rebuilt ADOPTS the agent
  identity from its siblings; it never invents one. On `identity-not-provisioned`, read
  `GET /threadline/health` (`relay.state`, `identityCoherence`) and the
  `agent-identity-missing` item; name the refusal reason, never guess. Replacing an EXISTING
  identity is MY action: after the operator's yes I move the conversation to the named machine
  (`POST /pool/transfer {"topic":N,"to":"<nick>"}`), run `instar identity adopt --from <sibling>`
  there, report the outcome, then unpin — never a file copy, never a command handed to the
  operator. A 409 (machine offline) means the item stays open; say so.
- **"Are my machines the same me on the agent network?"** → `GET /threadline/health →
  identityCoherence` (`agree` / `partial-agree` / `disagree` / `cannot-tell`). A split means
  peers' messages are queued and lost; the item names the machine and asks for the yes.
- **"Did <peer> get my message?"** → the send response's `relayStatus` AND `peerDark`
  (queued for hours, nothing acknowledged; `connectedNow` true/false/`null` = unknown; offline
  OR listening under a different address). `GET /threadline/peers/health` → `dark`,
  `darkSince`, `queuedCount`, `connectedNow`. Before blaming the peer, read my own `relay.state`.
- **"Why was my reply delayed / why did a topic go quiet on my other machine?"** → on a
  machine that does not hold the lease, replies are forwarded to the holder; a failed forward
  is a durable hold in `GET /telegram/origins/status` (`held[].hold_reason: lease-not-held`)
  with one attention item — never a silent drop.
- **Files tab**: identity, machine, SSH and HMAC key files are never served, listed or backed
  up; a 403 on one of these is correct, not a bug to route around.

## Out of scope (each with its carrier)

Cut from this spec under the 80/20 direction (2026-10-09); each is filed as an evolution
action at build time with this spec as origin, unless a carrier already exists:

- **Dashboard reconcile ceremony** (plan/commit routes, PIN, signed replace mandates,
  replicated commit record, `decideReconciliation` wiring, any mesh-callable replace) —
  carrier: the parent spec's open AC6/AC7b; §1.4 is the v1 path.
- **Join-time pin** (`afp` pairing-URL parameter, `--agent-fingerprint`, envelope stamp) — a
  wrong envelope is caught by §2 within 10 min. **Coherence-advert `agentFingerprint` field +
  MachineCoherence `identity` dimension** — the detector keeps its direct `/provenance` read.
- **Out-of-process corroboration** (relay registry self-lookup, inbound recipient
  fingerprints) — a unanimous-but-wrong fleet is reported by the PEER's §3 notice on their side.
- **Relay-side `recipientLastSeenAt` on queued acks; relay orphan retirement** — CMT-026,
  which now carries a trigger: the next relay deploy for any other reason, OR a second
  dark-peer episode whose cause turns out to be a wrong address — whichever first. The relay
  is the only party that can tell "offline" from "nobody has ever had this number".
- **Static `KEY_FILE_MANIFEST` ratchet** — the fixture walk (§5.4) is the v1 guard. **Dark-peer
  flap detection, ≥2-peers-crossing aggregation** — the 12 h cooldown bounds v1. **`capabilities`
  RPC cache per lease epoch; forwarding media/edits/pins from a standby** — v1 forwards
  `sendMessage`; the rest holds durably and is reported.
- **Rotation of the agent identity across the fleet / per-device certificates**; **at-rest
  passphrase for the canonical key** — the parent's accepted-cost boundary, now two incidents
  old; evolution actions `agent-identity-rotation-and-device-certs`,
  `agent-identity-at-rest-passphrase`, with a named trigger: a THIRD identity incident, a
  revoked machine suspected compromised, a
  fifth machine joining the fleet, or ANY further spec touching the adoption rules (a
  complexity trigger — the bridge must not keep growing), converts the rotation action into
  scheduled work.
- **A signed `agent-identity-adopt-trigger` mesh verb** (no key in the body) — rejected, not
  deferred: a compromised active sibling could make a healthy machine replace its good key.
- **The pool ownership-record divergence** also named in ACT-058 — stays with ACT-058 (WS1.3
  reconciler).

## Open questions

*(none)* — every question is resolved in Frontloaded Decisions.

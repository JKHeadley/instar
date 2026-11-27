---
title: Conversations Graph — Custody, Writes and Transfer
description: Developer reference for how the Conversations graph stores, writes, replicates and transfers conversation hierarchy records across an agent's machines — the custody side. Recovery, membership change, privacy and erasure are covered in the companion page.
---

This is a developer reference for the storage side of the Conversations graph: the code in `src/core/` that holds conversation-hierarchy records (which conversation delegates to which, effort headers, pinned state, source observations), writes them, replicates them among enrolled graph members, and moves custody between machines. It is written for people reading or changing that code. It describes what ships; it does not add new guarantees.

The companion page, [Conversations Graph — Recovery, Membership and Privacy](/architecture/conversations-recovery-privacy/), covers what happens when a machine is lost, how membership changes, how owner control is recovered, and how erasure works. The two pages overlap on purpose at the boundaries: transfer custody, witness storage and erasure fences each have a write side (here) and a recovery or deletion side (there).

The design spec is `docs/specs/conversation-effort-hierarchy-v3.md` (section 7.2 is the custody and replication ceremony). Most module header comments cite it.

## Two different "witnesses"

The word *witness* means two unrelated things in Instar.

- **Conversations graph witness** — `GraphWitnessService`, `GraphWitnessClient` and the other `GraphWitness*` modules on this page. A durable store that holds encrypted source bundles and signs prepare and commit records for graph writes. It belongs to one agent's own graph.
- **Threadline identity witnessing** — part of agent-to-agent messaging (see [Threadline internals](/reference/threadline-internals/)). It has its own keys, trust and protocol. Nothing in the graph modules reads or grants Threadline trust, and nothing here grants a new standing permission to any peer.

## Shipped default and how it turns on

The settings live under `multiMachine.conversationGraph` in `.instar/config.json` (type in `src/core/types.ts`; shapes shared with config in `GraphMembershipTypes`, which is plain types with no imports so config typing does not pull in the graph implementation). Server wiring is in `src/commands/server.ts`.

- **Release switches are off.** `readEnabled` and `correctionsEnabled` are documented in the type as "leave absent/off until increment-A acceptance". Storage being up does not by itself expose a read API.
- **External witness mode.** Only when `storage.enabled === true` *and* `witness`, `agentId`, `membership` and `ownerPublicKey` are all configured does the server open `ConversationGraphReplicationRuntime` against a remote witness through `GraphWitnessClient`. Peer and witness bearer tokens are read from the `SecretStore` by name (`peerBearerSecret`, `witness.bearerSecret`), never from config values. Once that configuration block is entered, a missing runtime prerequisite or either secret produces a `Conversations.storage` degradation and keeps graph routes unavailable. Missing one of the required configuration fields skips that block, leaving external graph storage off without a degradation report.
- **Owned-machine default.** When no external witness is configured and `storage.enabled` is not explicitly `false`, the server builds `ConversationGraphDefault` (`src/server/ConversationGraphDefault.ts`). It reopens an already pinned installation at boot, but the first root is only minted on an owner-admitted request. At first creation, `genesisMembers` selects the paired machines included in the owner-signed membership (all paired machines if absent). Pairing a machine later does not extend that existing signed roster. In this mode the witness engine (`GraphWitnessService`) runs on one of the agent's own machines (the profile's `hostMachineId`); other machines reach it through a peer transport. `OwnedGraphCustody` (`attachOwnedGraphCustody`, `openPublishedOwnedGraphCustody`) checks that the local machine, its signing key and the witness public key match the owner-signed custody profile before attaching.

## Layers at a glance

| Layer | Modules | Job |
|---|---|---|
| Wire contract and crypto | `GraphWitnessTypes`, `GraphWitnessCrypto`, `GraphWitnessControl`, `ConversationGraphSourceEnvelope`, `GraphOwnedCanonicalStream` | Canonical JSON, signature domains, bundle encryption, opaque control capsules |
| Intake and owner intent | `ConversationGraphIntake`, `ConversationGraphQueuedIntent`, `ConversationGraphOwnerIntent`, `ConversationGraphOwnerPolicy`, `DashboardPinGeneration`, `ConversationGraphUndo` | Idempotent reservation of writes, pre-admission owner intent, owner PIN policy |
| Commit and replication | `ConversationGraphCommitCoordinator`, `ConversationGraphReplication`, `ConversationGraphReplicationDescriptor`, `ConversationGraphReplicationProof`, `ConversationGraphReplicationLimits`, `ConversationGraphOperation`, `ConversationGraphDeliveryProof`, `ConversationGraphPendingCustody` | All-member certification and the durable source/outbox |
| Witness | `GraphWitnessService`, `GraphWitnessClient`, `GraphWitnessDispatcher`, `GraphCustodyTransport` | Independent durable witness and its transports |
| Source inventory | `ConversationGraphSourceInventory`, `ConversationGraphSourceSweep`, `ConversationGraphSourceSweepCapture`, `ConversationGraphSourceCoverage` | Witnessed flat-row inventory of real conversations |
| Live delegation | `ConversationGraphDelegation`, `ConversationGraphDelegationRemote` | Proposed "delegates-to" placements from real spawns |
| Custody profile and bootstrap | `GraphCustodyProfile`, `GraphCustodyBootstrap`, `GraphCustodyProfileAuthority`, `GraphCustodyJoinIntent`, `GraphCustodyStagedRole`, `GraphCustodyDurability`, `OwnedGraphCustody` | Who hosts the witness role, first creation, adding a machine |
| Transfer | `ConversationGraphReplicationTransfer`, `ConversationGraphTransferCustody`, `GraphPreparedTransferEnvelopes`, `GraphTransferPublicControl`, `GraphTransferPrivateViews`, `ConversationGraphMaterializationContexts`, `ConversationGraphContextCapacity`, `GraphOwned*` stream modules | Moving custody to a new membership |
| Local file safety | `GraphLocalFiles`, `GraphDurableFileMemo`, `GraphSourceCapacityLedger`, `GraphFrozenPhysicalInventory`, `GraphPublicMetadataPages` | Path containment, flush bookkeeping, local quotas |

The app-facing conversation store (`AppConversationStore`, `AppConversationService`, `AppConversationsReplicatedStore`, `ConversationPins`) and `EffortHeaderStore` sit beside the graph and are described in their own section below.

## Wire contract and cryptography

`GraphWitnessTypes` is the cryptographic wire contract: canonical JSON and hashing helpers (`canonicalJson`, `canonicalHash`), the `GRAPH_SIGNATURE_DOMAINS` table, `signGraphRecord` / `verifyGraphRecord`, membership-epoch verification, graph operation keys, and erasure-identity helpers. Its header states that no title or transcript plaintext belongs in it.

`GraphWitnessCrypto` encrypts bundles on installed members (`sealGraphBundle`, `openGraphBundle`, `rewrapGraphBundle`, `openRewrappedGraphBundle`). The scheme recorded in each bundle is `aes-256-gcm+x25519-hkdf-sha256`: content is AES-256-GCM, and a per-recipient envelope wraps the content key using an ephemeral X25519 key. Its comment is explicit that the remote witness never receives these keys — the witness stores ciphertext it cannot open.

`GraphWitnessControl` builds the permanent signed *control capsule* (`createGraphControlCapsule`, `verifyGraphControlCapsule`, `verifyGraphWitnessCustody`). The control is opaque and immutable; application bytes and key material live only in separately erasable ciphertext. Its verifiers reject extra fields even when correctly signed. `ConversationGraphSourceEnvelope` is the shared wire encoding (`encodeGraphSourceEnvelope` / `decodeGraphSourceEnvelope`) for the ciphertext that carries the accepted semantic core, original authorization and the erasable application bytes; the packet signature stays outside and binds the ciphertext hash.

`GraphOwnedCanonicalStream` (`GraphCanonicalArrayStream`, `graphCanonicalStreamHash`) hashes the same byte sequence as `canonicalJson` for a large array without building the whole string — data framing only.

## Writing: intake, owner intent and commit

A graph write passes through these steps:

1. **Owner intent.** `ConversationGraphOwnerIntent` (`parseGraphOwnerChange`) is the canonical shape of an owner change; validating its structure grants no authority. `ConversationGraphQueuedIntent` (`ConversationGraphQueuedIntentSpool`, `createEnrolledGraphOwnerIntentSpool`) holds owner intent *before* admission, without a sequence number. Its comment is clear that it is not a second graph store: no packet, receipt or journal entry exists until the real writer promotes the intent.
2. **Owner policy.** `ConversationGraphOwnerPolicy` reads the dashboard PIN policy straight from disk (`readConversationGraphOwnerPolicy`, `readConversationGraphOwnerCredential`), not from cached runtime counters, and `initializeConversationGraphOwnerPolicy` is the only path that creates a policy generation. `DashboardPinGeneration` keeps a separate revocation head file (`conversation-graph-owner-policy-head.json`) holding one UUID generation, so replaying an old whole config cannot restore a revoked PIN. It stores no PIN or PIN hash.
3. **Intake reservation.** `ConversationGraphIntake` makes durable idempotency reservations, so a retried write with the same key either replays or reports `GraphIdempotencyConflict`. Reservations hold the exact encrypted packet, never an owner credential. Intake does not decide acknowledgement — the coordinator does.
4. **Operation validation.** `ConversationGraphOperation` (`validateGraphOperationCore`, `validateGraphApplicationSource`, `deriveGraphErasureIdentity`) checks the transport discriminator; unknown kinds fail closed. Application custody is checked before any member signs durability.
5. **Commit.** `ConversationGraphCommitCoordinator` runs the all-installed-member commit. A witness *prepare* only means "Saved", never "committed": the coordinator reports a successful new write only after the final certificate and persistence proofs reach every installed member. It also has a cancel path (`GraphCancelOutcome`).

`ConversationGraphUndo` (`issueGraphUndo`, `readGraphUndo`) issues a signed, short-lived description of one reversible placement (it carries `expiresAt`); owner authentication and a current-head check are still required when it is used.

## Replication and the durable source

`ConversationGraphReplication` is the largest module: the durable source/outbox and all-member certificate replication. It stores immutable per-event files (intent, source, encrypted bundle) under its store directory and, per its own comments, fsyncs them and reads them back by hash before relying on them. The rotating coherence journal carries only `ConversationGraphReplicationDescriptor` records — opaque hashes — so the journal is a transport that can always be repaired from the source files; metadata alone never proves a member holds the original source.

Supporting modules:

- `ConversationGraphReplicationProof` — `signGraphAuthorizationReceipt` / `verifyGraphAuthorization` check the *original* installed fenced lease; a new lease is never accepted as a substitute.
- `ConversationGraphReplicationLimits` — fixed caps (`GRAPH_REPLICATION_MAX_RECORD_BYTES`) and the publication-version arithmetic. Exhaustion holds graph admission; it never clamps or rewrites a counter and does not restrict the native lease.
- `ConversationGraphDeliveryProof` — hashes publication facts for an existing signed delivery proof.
- `ConversationGraphPendingCustody` — `hasSeparateGraphPendingCopy` counts a pending copy as "beyond this disk" only if a verified, packet-bound copy exists on a *different enrolled identity*. Its comment says plainly that this names custody and **does not certify distinct physical disaster domains** — two machine identities on one physical host would pass.
- `ConversationGraphNativeTail` and `GraphVerifiedNativeTailBarrier` — every installed member closes its immutable pre-witness source tail and the union must form one exact prefix. These receipts prove a member's durable floor; they do not elect a writer.

## The witness

`GraphWitnessService` is the independent durable witness. It keeps state in a SQLite database (`better-sqlite3`) opened with `journal_mode = WAL` and `synchronous = FULL`. Its header: "A prepared witness proof never means an all-machine acknowledgement." It stages bootstrap uploads, holds erasure debt (see `GraphErasureWitnessLedger` on the companion page) and serves historical metadata.

`GraphWitnessDispatcher` (`graphWitnessEndpoints`) is a single dispatch table used by both HTTP and in-process transports, so the owned-machine witness and a remote witness run the same handlers. `GraphCustodyTransport` provides `createInProcessGraphCustodyTransport` (no local port), `createPeerGraphCustodyTransport` (other machines reaching an owned host), and restricted transports for staged roles and member loss in which positive custody methods stay unavailable. `GraphWitnessClient` is the client used by the replication runtime; it checks the witness id, public key and expected failure domain it was configured with.

Honest limits: the witness cannot read content, but it is still one store. In owned-machine mode it runs on one of the agent's own machines, so "witnessed" does not mean "stored in an independent failure domain" unless the configuration actually places it in one. The `failureDomain` field is a label the client checks for consistency; the code does not prove physical separation.

## Source inventory

The graph also keeps a witnessed inventory of the *flat* conversations that actually exist (app conversations, Slack registry entries, Telegram registrations), separate from graph events.

- `ConversationGraphSourceInventory` — signed source observations of a real server-owned row. An observation proves the row exists; it does not prove placement or owner authority. Titles and the machine-local open alias stay erasable. Activity time refreshes at most every 7 days (`GRAPH_SOURCE_ACTIVITY_REFRESH_MS`).
- `ConversationGraphSourceSweep` — signed, bounded inventory checkpoints (up to 1,000 rows per page, 32 pages). Unchanged inventories republish only on a 24-hour heartbeat and are marked stale after three missed heartbeats; stale only affects coverage, rows stay readable.
- `ConversationGraphSourceSweepCapture` — enumerates real rows from the actual `AppConversationStore`, `ConversationRegistry` and Telegram registration ports. No caller-supplied row list enters it.
- `ConversationGraphSourceCoverage` (`reconcileGraphSourceCoverage`) — a signed scan alone is not enough; the checkpoint and every row it references must be certified by all members, reconstruct locally and pass current erasure fences.

## Live delegation

`ConversationGraphDelegation` turns a real persisted spawn into a *proposed* delegates-to placement. The pending/witness pipeline still owns Saved and commit. Source records bind the session bootstrap capabilities, typed source identities, scope and the writer's signed lease. No prompt, title, token, message text or external sender id is kept, and a generic API bearer is not a source proof.

`ConversationGraphDelegationRemote` covers cross-machine spawns: requester and worker sign separately, and the request travels as `payload.graphDelegationRequest` inside the existing recipient-bound mesh RPC. In `server.ts` the receiving side refuses with `graph-remote-spawn-unavailable` when no runtime is running, and with `graph-remote-spawn-memory-scope-refused` for Telegram topics whose memory audience is scoped.

## Custody profile, bootstrap and adding a machine

- `GraphCustodyProfile` — the owner-signed deployment identity (`createGraphCustodyProfile`, `verifyGraphCustodyProfile`). Its comment: a role signature never implies a second disk.
- `GraphCustodyBootstrap` (`GraphCustodyBootstrapStore`) — first-use publication, pinned by every installed member before genesis. A native lease serializes bootstrap, but the lease holder still needs owner admission. The store never rotates a root and never treats a missing database as a fresh install.
- `GraphCustodyProfileAuthority` — the local custody authority. STAGING is a durable negative write fence; a proposed roster or a timeout never unlocks writes. Activation needs the owner-authorized certificate plus every installed recipient's hold and root-recovery receipt. Its header states the limit directly: **it cannot detect rollback of all authority copies.**
- `GraphCustodyJoinIntent` (`graphJoinAddition`) — adding a machine means exactly one new row; a join can never remove, swap or re-key a member, or move the host or witness.
- `GraphCustodyStagedRole` — new owned custody roles use the existing transactional witness engine: every member is held, the old role is durably retired, and the source archive is owner-signed.
- `GraphCustodyActivationPinStore` and `GraphCustodyActivationPinTypes` — per-member persistence of the activation (ACT) import, kept separate from pre-activation transfer holds.
- `GraphCustodyDurability` (`syncOwnedGraphIdentityDurably`) — an explicit durability barrier for the native decryption and signing material.
- `GraphCustodyPeerFrontier` — fresh peer observations can *withhold* private serving; they never elect a role or install a membership.

## Transfer

Moving custody to a new membership is staged so that nothing becomes canonical before activation:

- `ConversationGraphReplicationTransfer` — owner-authorized membership transfer staging. Staged bytes never enter the canonical graph and produce no source receipt before activation. `buildGraphTransferRewrapInventory` lists what must be rewrapped for new members.
- `ConversationGraphTransferCustody` — bounded pre-activation custody: one small index, immutable opaque controls, and separately erasable per-record ciphertext and key envelopes. There is no pending TTL.
- `GraphPreparedTransferEnvelopes` — randomized envelopes are prepared once in erasable custody; preparing them grants no root authorization or source acknowledgement.
- `GraphTransferPublicControl` — deep public-only inspection of transfer controls, using each nested proof's real verifier.
- `GraphTransferPrivateViews` — process-local, negative-only cleanup of parsed private views.
- `ConversationGraphMaterializationContexts` and `ConversationGraphContextCapacity` — paged, size-bounded transfer proof contexts and the capacity arithmetic for them. `ConversationGraphHistoricalMaterialization` verifies historical terminal source transfer against the owner's recovery plan and every new member's state-transfer receipt.
- Streaming in v2: `GraphOwnedSourceStreamV2`, `GraphOwnedSourceStreamReceiverV2`, `GraphOwnedSourceCommandV2`, `GraphOwnedVerifiedContextsV2`, `GraphPreparedCustodyStageV2` and `GraphCustodyProfileStageV2` stream owner-signed stages row by row under a new transport identity, never reinterpreting a v1 hash. A row transport ACK means "fsynced to staging", never Saved or a source acknowledgement.
- Control framing: `GraphOwnedControlFrameCache`, `GraphOwnedControlMetadataFrames` and `GraphOwnedControlCommandParts` split large controller commands into budgeted frames. The frame cache is ephemeral: **a restart discards frames** and callers resubmit the command.
- `GraphNativeSourceUpload` and `GraphWitnessBootstrapStream` — bounded upload of held source into the witness staging engine; completion must still pass the full source-recovery verifier. `GraphSourceStatusPoll` keeps polling a peer for up to 120 s (`SOURCE_STATUS_UNREACHABLE_LIMIT_MS`, 500 ms retry) because the peer's final step can block its server.

## Local file safety and durability

- `GraphLocalFiles` (`assertGraphLocalPath`, `ensureGraphLocalDirectory`) keeps graph files under the caller's canonical state root and rejects symlinks, including inherited ones.
- `GraphDurableFileMemo` calls `fsync` on descriptors and remembers what this process already flushed (device, inode, size, mtime, ctime) so unchanged files are not flushed again. The memo is process-local and **a restart starts empty**; a failed flush leaves nothing remembered.
- `GraphSourceCapacityLedger` is logical local credit only. Its comment: it does not preallocate disk, issue source acknowledgements, or prove a peer's capacity.
- `GraphFrozenPhysicalInventory` and `GraphPublicMetadataPages` are bounded filesystem and data-custody primitives with no authority of their own.

What these modules do *not* establish: `fsync` is called, but durability still depends on the filesystem and disk honoring it. Encryption protects content from the witness, not from a compromised installed member that holds the keys. "Every installed member" means every enrolled identity, which is not the same as independent hardware.

## Beside the graph: app conversations, pins and effort headers

These are not graph custody, but the graph reads from them and shares boundaries with them.

- `AppConversationStore` — the native app conversation store: one append-only JSONL file per conversation under `<stateDir>/app-conversations/`, immutable events keyed by `eventId` (created, label, message, delivery, media, tombstone, pin, …).
- `AppConversationService` — the native app conversation core: alias re-derivation at boot, ownership bindings (`serves`, `mayReply`, `currentOwner`), boot recovery of interrupted requests, and the rule that a non-owner answers `503 owner-unavailable` only after the message is persisted.
- `AppConversationsReplicatedStore` — the `appConversations` replicated-store kind. Events replicate to every machine whenever native conversations are on (`mobilePairing.native.enabled`); because events are immutable and keyed by id, the union has no conflicts, and deletion replicates as a `tombstone` event.
- `ConversationPins` — pinned messages are `pin` events in that store (switch `mobilePairing.native.pins.enabled`, on by default wherever native conversations are on).
- `ConversationRegistry` — the durable conversation id registry described in [Durable Conversation Identity](/architecture/durable-conversation-identity/); the source sweep enumerates it.
- `EffortHeaderStore` — metadata only for effort headers (`effort-headers.json`): operation cores, salted commitments, bundle references and a forgotten flag. Titles are resolved on demand through the graph's certified source custody; nothing decrypted is cached or written, and an erased source makes the title come back `null`.

## Where to go next

- [Conversations Graph — Recovery, Membership and Privacy](/architecture/conversations-recovery-privacy/) — member loss, owner recovery, witness recovery and erasure for the same modules.
- [Multi-machine session pool](/architecture/multi-machine-session-pool/) — the lease and machine model the graph relies on.
- [Machine identity recovery](/architecture/machine-identity-recovery/) — the enrolled identities that make up a membership.

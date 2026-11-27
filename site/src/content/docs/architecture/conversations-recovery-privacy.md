---
title: Conversations Graph — Recovery, Membership and Privacy
description: Developer reference for how the Conversations graph recovers after a machine goes away, changes membership, recovers owner control, and erases captured content across an agent's machines. Companion to the custody and write reference.
---

This is the second half of the developer reference for the Conversations graph in `src/core/`. The first half, [Conversations Graph — Custody, Writes and Transfer](/architecture/conversations-custody/), explains how records are written, witnessed, replicated and transferred. This page covers the other direction: recovering pending writes, changing or shrinking membership, recovering owner control, retiring old roles, and erasure.

It describes what the shipped code does, taken from module header comments and call sites. It does not add new guarantees. Spec: `docs/specs/conversation-effort-hierarchy-v3.md` (section 7.2, "installed membership recovery" and the recovery ceremony).

## Scope and defaults

Everything here runs only when graph storage is running — see "Shipped default and how it turns on" on the custody page. In short: the read and corrections switches under `multiMachine.conversationGraph` are off by default; an external witness needs explicit `storage.enabled: true` plus witness, membership and owner key settings; the owned-machine default (`ConversationGraphDefault`) mints its first root only on an owner-admitted request. None of the recovery flows below runs on an agent that never created a graph.

The *witness* here is the Conversations graph witness (`GraphWitnessService` and the `GraphWitness*` modules). It is unrelated to Threadline identity and trust ([Threadline internals](/reference/threadline-internals/)); no module on this page reads or grants Threadline trust, and nothing here adds a standing permission for any peer.

## Membership

A membership is an owner-signed epoch: the list of enrolled machine identities (signing and sealing keys), the writer, the witness id and failure-domain label, and an optional custody profile. Plain shapes live in `GraphMembershipTypes`; verification (`verifyMembershipEpoch`) and canonical hashing live in `GraphWitnessTypes`.

- In owned-machine mode, `ownedGraphInstalledRoster` in `OwnedGraphCustody` supplies active, unrevoked enrolled identities and their keys as candidates. The graph membership is the owner-signed epoch, not the whole candidate roster. At first creation, `multiMachine.conversationGraph.genesisMembers` selects which paired machines sign (all paired machines if it is absent); it has no effect afterwards. A machine paired later stays outside the signed graph roster until an owner-signed join. A roster sent in a request body is never authority.
- Adding a machine is `GraphCustodyJoinIntent`: exactly one new row, nothing else changed. Removing a member is a separate, much stricter path (member loss, below).
- `ConversationGraphCustodyAuthority` (`verifyGraphCustodyAuthority`) requires a *completed* activation for historical witness roles, not a proposed owner-signed roster; the original acceptance membership stays immutable.
- `GraphCustodyProfileAuthority` holds STAGING as a durable negative write fence during a change. A timeout never unlocks writes. Its stated limit applies here too: it **cannot detect rollback of all authority copies**.
- `GraphCustodyPeerFrontier` lets fresh observations from other members *withhold* private serving while their state is behind; it never installs a membership.
- `ConversationGraphReplicationLimits` makes a membership transition dominate every publication rank of the previous membership; exhausting the epoch space holds graph admission rather than wrapping a counter.

## Recovering pending writes

A write can be interrupted between witness prepare ("Saved") and the all-member commit described under `ConversationGraphCommitCoordinator` on the custody page. Recovery rebuilds and revalidates from what was actually stored, never from values supplied over the wire.

- `GraphWitnessRecoveryCoordinator` (`revalidate(eventId)`) re-checks one pending event against the current verified membership, the current fenced lease held by this machine, the original record read from `ConversationGraphReplication`, and the certified union of earlier events. It returns `held` with a reason when anything is missing — for example a certified dependency gap, ambiguous header creator, or stale heads for `set-primary-placement` / `set-front-door`. Terminal or erased operations are not revived.
- `ConversationGraphSourceRecovery` (`reconstructGraphSourceRecord`) reconstructs the *original* accepted control from the sealed source bundle; it never mints a new owner or producer receipt. The caller must zero the decrypted buffers. The wire encoding is shared with `ConversationGraphSourceEnvelope`.
- `ConversationGraphSourceObservationRecovery` lets the current native writer revalidate an earlier source observation (see `ConversationGraphSourceInventory` on the custody page). Historical producer membership stays frozen.
- `ConversationGraphRecoveryManifest` accumulates a metadata-only manifest of source entries (`buildGraphRecoverySourceManifest`); source authority is checked separately before any receipt. `GraphWitnessTypes` caps the manifest size (`GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES`).
- `ConversationGraphNativeTail` and `GraphVerifiedNativeTailBarrier` require every installed member to close its pre-witness tail so recovery starts from one exact prefix.
- `ConversationGraphIntake` keeps its reservations across restarts, so a retried owner write after a crash replays instead of duplicating.

What does not survive a restart: `GraphOwnedControlFrameCache` frames (callers resubmit), the `GraphDurableFileMemo` flush memo (it simply flushes again), and the process-local deny cache in `ConversationGraphLocalErasure` (see erasure below).

## Transfer on the recovery side

Transfer staging is described on the custody page (`ConversationGraphReplicationTransfer`, `ConversationGraphTransferCustody`, `GraphPreparedTransferEnvelopes`, `ConversationGraphMaterializationContexts`). On the recovery side:

- `ConversationGraphHistoricalMaterialization` accepts a historical terminal source transfer only with the owner's exact recovery plan plus every new member's durable state-transfer receipt. It never rewrites the original certificate or invents an old-epoch receipt.
- `GraphWitnessBootstrapStream` and `GraphNativeSourceUpload` upload held source into a new witness role's staging engine one row at a time; finishing still needs the full source-recovery verifier, and the server must recheck the owner action between stage and finish.
- `GraphCustodyStagedRole` opens staged and activated owned roles; `GraphCustodyActivationPinStore` records each member's activation import. The activation authority needs the complete verified pin set; the store never unlocks a profile on its own.
- `GraphTransferPublicControl` and `GraphTransferPrivateViews` inspect controls and clean up parsed private views without granting anything.
- `GraphSourceStatusPoll` tolerates a peer that is briefly unreachable during its final step (up to 120 s).

## Permanent member loss

Removing a machine that is gone for good is a separate, owner-confirmed protocol. It never relaxes the normal "every old member holds and retires" path; it adds a narrower one.

- `GraphOwnerMemberLoss` — verifies the owner's consent payload. Its header is explicit: there is **deliberately no exported mint or permission factory** while the owner service and native-authority integration are not implemented and reviewed. Consent is historical proof, not activation authority.
- `GraphMemberLossNativeProof` — verifies historical loss intent and native revocation receipts; neither admits a new human action.
- `GraphNativeMemberLossStore` (`GraphNativeMemberLossProgress`) — native lifecycle evidence recorded *after* owner administration. No method revokes a machine.
- `GraphMemberLossActivation` — the separate permanent-loss activation, including a fresh same-epoch holding proof presented at commit (`mintGraphMemberLossLeaseProof`).
- `GraphMemberLossPlanRevision` — a newly signed, negative-only plan revision; it never changes the original creation, consent, role key or transfer namespace.
- `GraphMemberLossHeldPreflight` — requires a real held physical source capability. The first adapter supports **exactly one surviving installed member**; more survivors need equally verified transport.
- `GraphMemberLossInventoryLimits` — a 64 MiB local held-snapshot budget (`GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES`). Refusal leaves the original custody intact; larger inventories need streaming.
- `GraphMemberLossNegativeCustody` and `GraphMemberLossNegativeTransfer` — after an explicit loss, pending writes can only be *cancelled*. A missing Saved proof is never repaired by inventing a witness preparation.
- `GraphMemberLossOwnedRole`, `GraphMemberLossPinStore`, `GraphMemberLossSourceImport` and `GraphMemberLossPublicMetadata` — the owned loss-role factory, survivor import pins, wire projection of retained source proofs, and read-only public-byte classification.
- `createMemberLossStagedGraphCustodyTransport` in `GraphCustodyTransport` keeps the loss role's transport negative-only.

## Owner control recovery

- `GraphOwnerRecovery` seals owner-control recovery material only to installed member keys (`createGraphOwnerRecoveryEnvelope`, `recoverGraphOwnerControl`). Decryption needs the exact owner root and the member's own decryption capability, and grants no HTTP admission. If material is missing, no root is invented.
- `GraphOwnerRecoveryStore` keeps those detached encrypted copies. A member signs its receipt (`verifyGraphOwnerRecoveryReceipt`) only after fsync, reload and self-decryption.
- `ConversationGraphOwnerPolicy` and `DashboardPinGeneration` decide which dashboard PIN generation is current. Revoking a PIN moves the generation head; replaying an older config does not restore the old one.

Limit: recovery copies live on installed members. If every member is lost, these modules do not provide an outside copy.

## Retiring old roles

- `GraphCustodyRetiredRoles` — current verified negative authority purges every discovered custody role (`GraphCustodyRolePurgeDebt` tracks what is left). No historical signing key is loaded.
- `GraphCustodyRetiredRolesInventory` — read-only, bounded disk inventory of role files; claims are not authority until bound to owner-pinned lineage.
- `GraphPreparedCustodyStageV2` / `GraphCustodyProfileStageV2` — paged negative-stage evidence; not retirement or activation by itself.
- `GraphFrozenPhysicalInventory` and `GraphPublicMetadataPages` give these readers bounded, hash-checked data with no authority attached.

## Erasure and privacy

What the graph keeps is designed to be erasable: titles, previews, transcripts and keys live only in encrypted bundles and per-record envelopes, while signed controls hold opaque hashes (see `GraphWitnessControl` and `GraphWitnessCrypto` on the custody page). Effort header titles in `EffortHeaderStore` resolve through that custody and come back `null` once it is erased. Erasure works in layers:

1. **Local fence first.** `ConversationGraphLocalErasure` (`ConversationGraphLocalErasureFence`) records owner-local suppression before any network work. It is a deny fence, not a claim that anyone else erased anything. Its in-process deny cache is never cleared after a refresh, but its comment notes it is **not evidence that an unsynced deny reached disk**.
2. **Durable negative authority.** `ConversationGraphErasureAuthorityStore` keeps verified erasure authority. Pins alone never authorize deletion.
3. **Protocol.** `GraphErasureProtocol` defines the signed ingress, the fleet plan and per-member receipts, with scopes `graph-source`, `graph-intake`, `graph-transfer` and `graph-source-cache`. It carries no title, transcript, content key, owner credential or source bytes.
4. **Fleet coordination.** `GraphFleetErasureCoordinator` purges locally, then forwards an `erase-purge` to every other member. A sleeping member that cannot be reached stays a named pending copy rather than a silent success. Its scope is narrow: it **does not erase original platform or legacy transcripts, or phone downloads** — only graph-captured application custody.
5. **Witness storage.** `GraphErasureWitnessLedger` records deletion debt in the same transaction inside the witness database; `GraphWitnessErasureStorage` (`enforceGraphWitnessTargetErasure`, `purgeGraphWitnessStagedBundle`, …) is the data-only purge engine, run only after negative authority is established.
6. **Intake.** `ConversationGraphIntake` reports `GraphIntakeSourceErased` for reservations whose source was erased.

Honest limits: an erasure acknowledgement means the member's graph-managed copy was purged by this code. It does not prove that filesystem blocks were overwritten, that backups or snapshots outside Instar were touched, or that a member that never comes back has deleted anything.

## Related app-conversation recovery

`AppConversationService` handles boot recovery for native app conversations (re-deriving aliases, recovering interrupted requests, answering `503 owner-unavailable` after persisting). `AppConversationStore` deletes by appending a `tombstone` event, which `AppConversationsReplicatedStore` replicates to every machine; `ConversationPins` pins replicate the same way. These are separate from graph erasure: purging graph custody does not rewrite the app conversation JSONL, and a tombstone in the app store is not a graph erasure.

## Where to go next

- [Conversations Graph — Custody, Writes and Transfer](/architecture/conversations-custody/)
- [Machine identity recovery](/architecture/machine-identity-recovery/) — the enrolled identities a membership is built from.
- [Durable Conversation Identity](/architecture/durable-conversation-identity/) — `ConversationRegistry`, which the source sweep reads.

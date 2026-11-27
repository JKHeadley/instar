# Side-Effects Review — Work front doors, stage 2: Chief of Staff `tree` import into the conversation graph

**Version / slug:** `work-front-doors-stage2-cos-tree-import`
**Date:** `2026-11-20`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Spec `docs/specs/work-front-doors.md` §3.1 (row "Chief of Staff project") and §7 stage 2: "imports `tree` placements idempotently, preserving owner corrections", while both the CoS tree and the graph keep being written until every machine runs the import and every reader reads the graph. This change ships the import; it does NOT stop the CoS tree writes (tracked as CMT-2074 <!-- tracked: CMT-2074 -->).

- `conversationGraph.ts` validator: an `import`-authority placement must be `coordinates` (a conversation directly under an effort) and must replace nothing. So an import can only ever be a first placement.
- New `src/core/ConversationGraphCosTreeImport.ts` (pure): the import source (the tree record's child key, parent key, HLC and origin, the child and project refs, the effort and the owner front-door event that maps project -> effort, plus the writer, its graph lease epoch and a deterministic event time = the later of the tree write and the lease start), deterministic event / receipt / idempotency ids derived from a hash of that source, the core builder (every core field comes from the source), the receive-side verifier, the planner and the gate.
- `ConversationGraphReplicationProof.verifyGraphAuthorization`: new authentication method `cos-tree-import`, valid only for a graph-event with `authority: 'import'` and an `import-record` receipt, and only when the core is byte-for-byte what the carried `importSource` yields for that agent and writer. An import source on any other method is refused (`unexpected-import-source`). Older builds refuse the method (`malformed-authorization`).
- `ChiefOfStaffStore.foldTreeRecords` / `ChiefOfStaffLoop.treeRecords()`: read-only, the live tree records with each winning write's HLC and origin (tombstones removed by the same merge rule as `foldTreeState`).
- New `src/server/ConversationGraphCosTreeImporter.ts`: on the graph writer only, every 10 minutes (first pass 90 s after boot), when the gate is open: plan from the certified graph snapshot, then per import, under the graph mutation lock, re-check (same live tree write, child still without any placement event, same mapping) and submit through the ordinary witnessed all-member commit path with a member-signed `cos-tree-import` receipt. At most 25 imports per pass.
- Gate: `multiMachine.conversationGraph.cosTreeImport` through the dev-agent gate (absent = live on development agents, dark on the fleet) AND every other member of the installed graph membership advertising `seamlessnessFlags.conversationGraphImportAuthority: true` in its capacity heartbeat (unknown keeps it shut). The flag is a build capability, advertised unconditionally by this build (the `documentsDecisionRows` pattern).
- `ConversationGraphOwnerChanges`: `ownerObservedHeads` — an owner placement whose observed heads differ from the current ones only by IMPORT heads it did not see is still current (the event names every current head, so it replaces the import). Before this, an import landing between an owner's preview (or an owner change saved offline in the local owner queue, or one recorded on another machine and forwarded) and its commit would have made that owner change `placement-conflict` / `stale-heads`. Any unseen owner or delegation head is still a conflict, exactly as before.
- The runner also treats every subject named by an owner change in the local owner queue (`intake.ownerQueue.pendingPage`) and in source control intents as `change-pending`, so it does not race an owner change saved here in the first place.
- `AgentServer` constructs and starts the runner when a Chief of Staff loop and a graph runtime (direct or owned default) exist; `stop()` stops it.
- Awareness entry `src/data/awareness/chief-of-staff-tree-in-conversations.md`.

Tier 2 (replicated graph authority, a new receipt kind every machine must verify). Size: 7 modified + 4 new source/awareness files, about 470 lines including tests. Effort: plan, one build pass, one review pass (see second pass).

## Decision-point inventory

- **New authority:** the import tier may now write. It is the second-lowest tier (owner > delegation > import > inference); the reducer already lets an owner event replace or outrank it. It writes only a FIRST placement (validator), only for a tree child of a project the owner already accepted (certified owner front door), only when the child has no placement event of any tier and no pending one.
- **No blocking authority added.** The importer never refuses, holds or hides anything; skips leave the conversation exactly as it is today (unfiled / where the owner put it).

## 1. Over-block

- A child whose conversation is Slack (or any key without a graph ref here) is not imported (`unmapped-key`), same as stage 2b.
- A child not yet in the certified source inventory is skipped (`unknown-conversation`) until it is; the next pass picks it up.
- A project whose effort has two front-door heads (an owner conflict) is skipped (`front-door-unsettled`) until the owner resolves it.
- A child the owner ever placed or removed is never imported, by design (owner corrections win), even if the owner later "un-removes" it by hand elsewhere.
- While any graph member does not advertise the build, nothing imports at all (by design: an import cannot certify there).

## 2. Under-block

- Idempotency: the ids hash the whole source, which includes the writer and its lease epoch, and the event time is derived from the source (not the clock), so the same writer in the same lease re-running produces byte-identical bytes and is skipped by id (`already-imported`; any id held in source, control intents or intake). A different writer or lease epoch (failover before the first import replicated) produces a DIFFERENT event id, never one id with two payloads (which would fork the writer's source tail and stop every later graph write there). Two such imports both replace nothing and name the same parent, so the reducer treats them as agreeing heads: no conflict, nothing set aside (unit test). The planner sees the first one's head after it replicates and stops.
- Verifying members check that the import event is exactly what its carried source yields for that agent, writer and lease epoch; they do NOT check that the tree record exists in their own CoS replica or that `frontDoorEventId` is that effort's certified front door. A member machine holding the lease could therefore sign an import of any conversation under any effort. That is not new power: owner receipts are also signed by a member machine after it checked the owner's proof. Disclosed, not hardened here.
- A machine that joins the graph membership later on an OLD build would fail to verify already-committed import records during its historical catch-up (it refuses the method). That is loud (its catch-up refuses), not silent, and is the same posture as any newer-receipt record; machines in a pool auto-update to the same build.
- A heartbeat that still says `true` from a machine that has just been rolled back to an old build could open the gate for up to one heartbeat; an import emitted in that window stays pending until that machine updates again. Rollback of a single machine below the pool's build is already unsupported for the graph.
- The tree record is tied to the replicated CoS store by the writer (re-read under the mutation lock, same HLC + origin must still be the live winner), not re-checked by each verifying member against its own replica. Doing that check at verify time would make a member with a lagging CoS replica quarantine a valid record, which turns the whole graph partial; verification stays pure and historical like every other graph proof.

## 2b. Spec note: hierarchy v3 vs work-front-doors

`docs/specs/conversation-effort-hierarchy-v3.md` describes an imported link as "a cited candidate until the owner accepts it" and lists owner correction and authenticated delegation as the placement authorities. `docs/specs/work-front-doors.md` §3.1 (later, approved by Justin 2026-11-15) specifies that stage 2 "imports `tree` placements idempotently, preserving owner corrections", with the graph winning on disagreement. This change follows work-front-doors: the owner's Accept of a project (the stage 2b owner action that certifies the front door) is the acceptance that admits that project's tree children, and each import is the lowest placing tier, shown as "placed by import" and correctable like any other. The tree children were placed by the owner's own taps in the Chief of Staff tree in the first place (`chief-of-staff-topic.md` §1: only the owner's taps write `tree`).

## 3. Level-of-abstraction fit

The import is a new authority on the existing graph, written through the existing commit path, modelled on the delegation tier (typed source carried in the proof, verified in `verifyGraphAuthorization`). The mapping reuses the stage 2b owner Accept (certified front door). No parallel tree, no second store.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`: the importer holds no blocking authority. Its writes are the lowest tier that actually places, every one outranked by any owner event, and its "decision" is purely additive (fill an empty slot). Verification is a cryptographic/structural check (the existing pattern), not a judgement.

## 5. Interactions

- **Owner changes:** an owner move/removal of an imported child names the import head in `replacesPlacementEventIds` (from `placementHeads`), exactly as for any other head. A concurrent owner placement and import both with no predecessor: the owner head wins by tier (test).
- **Owner "subject-change-pending":** that check only looks at owner-method records, so a pending import does not block an owner change; the owner change then replaces it or outranks it.
- **The reverse race (an import committing while an owner change is pending):** the importer skips subjects of owner changes in the local owner queue and control intents, and `ownerObservedHeads` makes an owner change that did not see an import head still current (it then replaces the import). So an owner change saved offline, forwarded from another machine, or previewed before the import is never refused because of an import (unit test for the rule; integration test for the queue skip).
- **Front-door guard:** a child that is itself a certified front door is skipped (`is-front-door`); the project conversation itself already has its owner placement.
- **Delegation ingress:** it treats any non-delegation head as "non-agent-placement-exists" (suggestion), so an imported child is not re-placed by a later dispatch. Unchanged behaviour for non-imported children.
- **Stage 2b suggestions:** project members already placed by an import are no longer "unassigned", so a later project suggestion offers fewer members; Accept of an already-accepted project is not re-offered. No double work.
- **Commit pipeline:** each import is one ordinary graph event; at most 25 per pass, serialized under the same mutation lock as owner changes.
- **CoS loop:** read-only (`treeRecords()` loads the union on each call, at most 1 + 25 times per 10-minute pass). CoS tree writes are untouched.

## 6. External surfaces

- Conversations (dashboard and phone) show imported children under their project with `placedBy: 'import'` ("Why here?" already renders the tier).
- Capacity heartbeat gains one boolean (`conversationGraphImportAuthority`). Older receivers ignore unknown flags (the field is copied through as an object).
- No new route, no user-facing message, no Telegram.

## 6b. Operator-surface quality

No new operator surface. The existing tree view shows the imported placement like any other; the owner moves or removes it with the existing controls.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated.** Import events ride the graph's witnessed all-member commit (every member persists and verifies before it counts). The CoS tree they read is the replicated `chief-of-staff-record` union. The runner is lease-holder-only; standbys report `not-writer` quietly. The gate is pool-wide by construction (every member must advertise the build). No machine-local state is added.

## 8. Rollback cost

- Switch off: `multiMachine.conversationGraph.cosTreeImport: false` stops new imports immediately (read each pass).
- Already-committed imports are ordinary graph events; the owner can move or remove each (an owner change replaces the import head).
- **A plain build revert is NOT a safe back-out once any import has committed.** A build without this change cannot verify a stored `cos-tree-import` record: it would set it aside as unverified, which marks the graph snapshot partial and makes owner changes answer "not current", and a machine whose own source tail holds such a record can stop admitting graph writes altogether (`graph-runtime-unverified-source-tail`) until the build returns. The back-out is the switch (above) plus, if the code itself is wrong, a forward fix that keeps verifying the stored records. While no import has committed (every fleet agent: the switch is dark; a dev pool: until every machine runs this build), a revert is clean. This is the same one-way property every new graph receipt kind has.
- No data migration.

## Evidence

- Unit `tests/unit/conversation-graph-cos-tree-import.test.ts` (16): two writers / two lease epochs never share an id and their imports agree in the reducer, same writer re-run is byte-identical; `ownerObservedHeads` (an unseen import head keeps an owner change current, an unseen owner head does not); validator limits; deterministic and idempotent ids; unaccepted and uncertified mappings untouched; owner placement, owner removal and pending change all skip; root / front door / unknown / unmapped / parentless; tombstone via the real CoS fold and builders; project scope; owner wins in the reducer (concurrent and later); the real `verifyGraphAuthorization` accepts a matching import and refuses a moved core, a tampered source, a missing source, an import core on an owner method; an unverified import is set aside by the reducer; strict source shape; the gate; runner preconditions (off / not ready / gated / standby not-writer, no tree read).
- Integration `tests/integration/conversation-graph-cos-tree-import.test.ts`: real two-member runtime + real witness + real source inventory + owner events through the signed submit path. Gate shut (peer not advertising) and switch off write nothing; then exactly one import commits on BOTH machines, `placedBy` import, an owner-filed child is not moved, an unaccepted project is untouched; the stored proof carries the tree record and verifies; a forged source is refused; a child with an owner change waiting in the local owner queue is skipped (`change-pending`); a re-run writes nothing; the owner's removal of the imported child wins and a later run does not undo it.
- E2E `tests/e2e/conversation-graph-cos-tree-import-alive.test.ts`: the production AgentServer composition constructs the runner, it is `not-ready` before the graph opens, then reads the real CoS tree and real certified graph and writes nothing for an unaccepted project; on a fleet (non-dev) agent it is `off` and reads nothing.
- Existing suites green: unit `conversation-graph*`, `graph-*`, `ChiefOfStaff*`, `chief-of-staff*`, awareness, work-front-doors (82 files, 995 tests); integration owner changes, delegation, replication runtime, suggestions, CoS replication and app surface, graph surface (55); e2e graph surface, suggestions, CoS alive, replication lifecycle (7). `tsc --noEmit` clean; all 54 lint steps pass.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus 5.5), given the diff and this artifact. **Independent read: concern.**
1. An import could make an owner correction stale: owner changes refuse `placement-conflict` / queued intents finish `stale-heads` when the heads they observed changed, and the runner ignored owner changes saved in the local owner queue and control intents. Contradicts "an owner placement always wins".
2. Two writers (failover before replication) could produce one event id with different bytes (the id hashed only the source; the event carries its writer and a clock time). `submitPrepared` throws `graph-runtime-source-fork` on that, stopping every later graph write on the machine, not just leaving one child unfiled as §2 claimed.
3. Smaller: receivers do not check the tree record or front-door event against their replicas (not new power; disclose); hierarchy v3 calls an import "a cited candidate until the owner accepts it" (note the conflict); rollback should name the source-tail wedge on a rolled-back member.
4. Checked correct: no existing method accepts anything new; `importSource` refused on other methods and covered by `controlHash`; import limited to a first `coordinates` placement; owner/delegation always beat import in `resolveChain`; an owner removal counts as a head; lease-holder only with re-check under the mutation lock; the gate fails shut on unknown.

### Resolution (author)
- 1: the runner treats subjects of owner-queue intents and control intents as `change-pending` (integration test); new `ownerObservedHeads` (preview and submit): unseen IMPORT heads do not make an owner change stale, the owner event replaces them; unseen owner/delegation heads still conflict (unit test). §5 updated.
- 2: the source carries `writerId`, `leaseEpoch` and a deterministic `createdAt`; ids hash the whole source; the verifier binds writer and epoch to the packet. Same writer re-run is byte-identical; different writer/epoch is a different id, and both imports agree in the reducer (unit test). §2 corrected.
- 3: §2 discloses the receiver-side limit; §2b records the v3 vs work-front-doors §3.1 note; §8 names `graph-runtime-unverified-source-tail`.

**Re-check after fixes: concur** (same reviewer; re-ran the unit file, 16/16). Non-blocking notes: (a) a tree record whose HLC time is ahead of the writer's lease window (clock skew) gives an event time later than the lease; harmless (the receipt's `acceptedAt` is the real time and is what the lease check uses; the event time only orders imports among themselves); (b) the receiver-side limit above, disclosed.

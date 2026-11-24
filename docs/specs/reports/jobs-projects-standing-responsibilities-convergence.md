# Convergence Report — Jobs, projects, and standing responsibilities

## Cross-model review: codex-cli:gpt-6.2-astra

The installed Codex reviewer ran on six exact bodies. Gemini was unavailable without authentication and the clean Anthropic wrapper was unavailable. Three independent internal reviewers covered the six security, adversarial, deployment, performance, lessons and decision lenses. They counted five frontloaded decisions and zero cheap-to-change tags. Final internal lenses cleared their material findings. The final external conclusions and the cap disposition remain explicit.

## ELI10 Overview

Jobs do repeatable work. Finite projects have an end. A standing project gives a permanent responsibility a home, uses existing jobs for checks and keeps follow-up with its owner.

## Original vs Reviewed

Review added independent health, four executor variants, safe staged payload verification, portable rollback fencing, current checklist evidence, all-member project custody, and bounded continuation. New governed external actions stay gated on the separate admission review.

## Iteration Summary

- Round 1, reviewable body `24542df92c139b55d0144902089f768100225d3d733690ab6f2ee8b917a449ed`. Standards-Conformance Gate: ran (3 flags).
- Round 2, reviewable body `0b0d28eeccf3c75d636f02706e3966cdbba5624d9a23b773524d0a8a7796cab2`. Standards-Conformance Gate: ran (3 flags).
- Round 3, reviewable body `13039e2fe1c8c4b5d3b7093a9ac92ade97efabfef0c1b8c2413868526e76e375`. Standards-Conformance Gate: ran (2 flags).
- Round 4, reviewable body `a57fddcf914ebf6997ffc633175f06d66471decc2e845fac1e0d68bff985302b`. Standards-Conformance Gate: ran (3 flags).
- Round 5, reviewable body `2d018828e8120bbea903ebe72c212620ae507e88186c2a5bdac19489b9ae85d7`. Standards-Conformance Gate: ran (1 flags).
- Round 6, reviewable body `efbb91dad659b855799d5e0f946917fb87d1747070e1293e638e96b6774108b8`. Standards-Conformance Gate: ran (1 flags).

## Proportion

Tier 2, six of six rounds. The design introduces cross-source or cross-machine contracts. Independent lenses and external review repeatedly narrowed concrete failure modes.

## Experience fit

Test real operator Jobs and Work views. A completed review cannot make a full drive healthy. Existing agents receive equivalent Machine Stewardship review when authority is verified, and the finding remains visible only where the owner allows.

## Left behind

- External DESIGN and data-integrity risk: member acknowledgments must enforce one eligible successor vote for each predecessor and membership epoch. Recovery must finish the chosen decision or safely refuse competing writes, including after a holder crashes before certificate distribution.
- External DESIGN: continuation brakes need one cumulative project/run budget across linked conversations, persisted with step and restart identity.
- External DESIGN: pooling checklist evidence needs an explicit source binding HLC and item identity to canonical revision proof. Otherwise edit-and-revert could inherit stale authority.
- Conformance precision: explain the authority epoch (version of the current writer) and final accepted source sequence before operator handoff.

## Full Findings Catalog

### Round 1

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Canonical project roster / Multi-machine posture.** Chief of Staff §1.2 says TaskFlow’s SQLite registry is machine-local. The replicated binding currently preserves project status when the holder disappears. Spec B moves authority to the project service and prefers TaskFlow, but never identifies how a successor recovers the last accepted project revision. Spec A requires each enrollment to name its custody adapter. Specify where the project service durably records accepted revisions, what checkpoint permits takeover, and what the successor serves when that proof is unavailable. Test loss of the holder immediately after it acknowledges a status change.

2. **DESIGN — Canonical project roster.** Chief of Staff §§1.2, 1.3 and 2.6 bind closure to the exact checklist revision and distinguish owner-confirmed items from items the owner delegated. Spec B assigns the project service the goal and accepted evidence, but gives no migration or write rule for the checklist and its per-item delegation. A delayed confirmation could close a project after its owner changed the finish criteria. Migrate the checklist and delegations together, bind completion to their canonical revision, and test an owner edit racing a confirmation from another linked conversation.

3. **DESIGN — Turn-end continuation.** Spec B permits multiple conversations per project and one authorized step per completed turn. Chief of Staff §2.4 serializes execution per conversation. Two distinct turns could therefore select the same project step, each with a valid occurrence and a different conversation lock. Have the project owner atomically reserve the step against the expected project revision before dispatch and return the recorded operation to competing callers. Test simultaneous turn endings while the first dispatch acknowledgment is delayed.

4. **DESIGN — Standing responsibilities, finding ownership and expiry.** The spec says repeated observations update one finding and verified recovery closes it. It leaves the ordering rule unspecified. A delayed healthy observation could close a newer full-drive finding for the same machine and volume. Define which observation can resolve the current condition and how a recurrence after verified recovery affects the linked card and suppression. Test delayed and replayed observations across recovery and recurrence.

### Round 2

**Verdict: SERIOUS ISSUES**

- **DESIGN — Canonical project roster.** Chief of Staff §1.2 makes the binding authoritative for closure and explicitly allows its InitiativeTracker status mirror to lag. An exact ID match therefore proves identity while leaving the correct status to be determined. The migration routes inconsistent matches to the owner even though this case already has a deterministic answer. At the final fence, fold lifecycle events against the winning binding revision and seed the canonical project from that result. Test a valid closure whose mirror write failed, plus a closure invalidated by a later checklist edit.

- **DESIGN — Turn-end continuation.** The spec reserves a logical step per project. Chief of Staff §2.4 serializes execution per conversation, and §4 allows a Chief of Staff–started run to finish its bounded duration after the operator lease expires while prohibiting a new restart. The continuation section does not specify how that restriction follows a run into its turn-end consumer. Carry the run’s initiating authority and the project reservation ID into the conversation’s spawn or inject path. Test lease expiry between task completion and dispatch. A replacement run must require current restart authority, including when another linked conversation receives the completion signal.

- **DESIGN — Canonical project roster, Multi-machine posture.** The spec requires recovery of the exact last acknowledged revision after immediate holder loss. Chief of Staff §2.4 describes a local durable append followed by replication. Checking recovery proof only when a successor takes over can detect a missing revision but cannot recover its bytes. Define the acknowledgment point at the original writer. For installations promising holder-loss recovery, require an authorized independent copy through that revision before returning success. Specify what a single-machine or disconnected writer returns. Test loss after local flush and before peer persistence.

- **DESIGN — Standing responsibilities, finding ownership and expiry.** Findings order observations only within one evaluator generation, yet healthy evidence must be later than the triggering observation to close an episode. A holder change between a disk-full observation and the first healthy check leaves that comparison undefined. Have the successor adopt the verified condition head and record a fresh check against that head. Test that the successor can close the episode and that a delayed result from the former holder cannot reopen it.

### Round 3

**Verdict: SERIOUS ISSUES**

- **DESIGN — Canonical project roster.** Chief of Staff §1.2 selects a winning binding **per conversation**. The draft permits several conversations per project but instructs migration to replay the winning binding for a paired project. Two exact links can therefore establish the same project ID while supplying different checklists, delegations, and closure states. Group bindings by canonical project ID before replay. If their lifecycle evidence conflicts, preserve both and require owner resolution. Test one confirmed-closed binding and one open binding linked to the same project.

- **DESIGN — Standing responsibilities, finding ownership and expiry.** The review rule requires checks to have run and open findings to have an owner or review disposition. A disk check can run, confirm the disk is full, and have its finding assigned. Those facts establish coverage and follow-up while the capacity condition still fails. Define separate outcomes for review completion and condition health. Test that assignment completes triage while capacity remains degraded until a fresh observation verifies recovery.

- **DESIGN — Canonical project roster / Multi-machine posture.** The draft requires independent custody for project status, checklist, effect, and ownership revisions. It also makes the project service authoritative for goals, mode, and standing review obligations, without specifying whether the signed revision carries those facts or how a successor recovers them. A1 requires a recovery source for each enrolled fact family. Specify the complete recoverable project revision and the authorized references it uses. Test holder loss immediately after acknowledging a goal edit and a change to the current review window’s obligations. Verify the successor can reconstruct both values and their revisions.

- **DESIGN — Turn-end continuation.** The draft requires replay of durable pending signals. It specifies subscription to framework events but leaves the interval between framework completion and durable receipt uncovered. A consumer crash in that interval could strand an eligible step before a reservation exists. For each adapter, require a replayable completion cursor or reconciliation against durable run history by run and turn ID. Test a crash before the consumer’s first write and verify that recovery reserves the step once.

### Round 4

**Verdict: SERIOUS ISSUES**

- **DESIGN — Canonical project roster.** The migration checks whether linked bindings disagree on closure, checklist or delegation. It gives no resolution rule for two owner-confirmed bindings with the same checklist and different goals. Chief of Staff §§1.2–1.3 stores the goal on each binding, and its operator grant permits restarts only within that goal. Choosing either goal silently could redirect future work. Include goal text in the compatibility check, preserve both originals on disagreement, and require an owner decision before enabling continuation for that project.

- **DESIGN — Turn-end continuation.** The consumer may advance its event cursor after recording a step reservation. The spec describes replaying pending signals and reconciling outbound claims, but leaves the transition between reservation and outbound claim unspecified. A crash in that interval could leave every competing producer respecting a reservation that nobody will dispatch. Make the reservation itself a durable pending dispatch, or atomically enqueue one with it. Test a crash after cursor advancement and before the first outbound claim. Recovery should dispatch the step once or record why it was parked.

- **DESIGN — Independent job liveness.** The evaluator advances its durable watermark only across verified intervals. The same section anticipates permanent retention gaps and requires current checks to continue, but gives no rule for checkpointing verified work beyond such a gap. A1 §Capture and link work already distinguishes the maximum observed offset from contiguous completeness and records gaps separately. Apply that pattern per placement scope. Test a permanent historical gap followed by two eligible intervals and a restart. The gap should remain visible, and each later interval should retain its own verdict.

- **DESIGN — Standing responsibilities / Turn-end continuation.** Standing reviews record completion per interval, while the shared lifecycle arbiter can “finish with accepted evidence.” Chief of Staff §2.6 closes the project when its checklist passes. The spec needs a mode-specific transition at that seam. For a standing project, bind completion evidence to the window ID, close that window, and retain the next review obligation. Test two consecutive healthy windows through the normal supervision path and verify that the same project remains active until an authorized retirement.

### Round 5

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Canonical project roster, pooled write recovery.** The spec requires every enrolled member to persist a revision before the holder acknowledges success. Chief of Staff §1.2 describes a carrier that merges whole records by timestamp. A successor holding revision N cannot tell from those bytes alone whether every member persisted N or only the successor did. Define how a successor recovers the membership epoch, durable acknowledgements and accepted head before serving N or accepting N+1. Test holder loss both before the final member persists N and immediately after the client receives success. The successor must distinguish those cases or report the decision as unavailable.

2. **DESIGN — Turn-end continuation, closure after lease expiry.** The spec explicitly rechecks the Chief of Staff operator lease for a new run. It also lets the lifecycle arbiter accept completion evidence and close a finite project or standing review window. Chief of Staff §4 allows an admitted run to finish after expiry and expressly forbids a new CoS closure. Require the project service to recheck the initiating CoS authority when it commits either closure. Test a run whose final evidence arrives after expiry. Preserve the evidence and leave closure pending until authorized.

3. **DESIGN — Canonical job definitions, portable rollback.** The cutover explicitly fences portable import and legacy migration cancellation. The approved replication spec also names a stopped-agent rollback command and a live rollback route that quarantine imported manifests. Those are separate mutation paths, and stopping the agent does not establish that the rollback command understands the published epoch. Enroll both paths in the cutover inventory. After publication, route rollback through the canonical owner or refuse it before moving files. Test both against a journal-proven import after cutover and verify that accepted definition, payload availability and execution eligibility still agree.

### Round 6

**Verdict: SERIOUS ISSUES**

1. **DESIGN — Canonical project roster.** The draft requires every authorized member to persist the revision and commit certificate before shared success. It also permits reconstructing the certificate from durable acknowledgments. Chief of Staff §1.2 describes a carrier that merges whole records by timestamp. Neither text defines what prevents a member from signing two successors of the same accepted head. A holder crash after signatures are collected but before certificate distribution leaves the next holder with an ambiguous retry decision. Specify a durable per-member rule allowing one vote per predecessor and membership epoch, define when the decision becomes binding, and require recovery to finish that decision before admitting a competing revision. Test a different edit against the same predecessor during failover.

2. **DESIGN — Turn-end continuation.** The draft reserves a logical step across linked conversations but inherits supervision budgets without specifying which record owns the budget. Chief of Staff §§1.2 and 2.7 derive restart counts, backoff and breaker state *per conversation*. Two conversations can therefore respect every individual reservation while alternating successive no-progress attempts beyond the intended project limit. Persist the project’s cumulative attempt count, next eligible time and breaker state with its step reservation. Test alternating conversations across a restart and verify when the project parks.

3. **DESIGN — Canonical project roster.** The migration merges compatible evidence for the “same checklist revision.” Chief of Staff §1.2 identifies each winning binding by its own HLC, and §1.3 makes judgment delegation specific to an item in that binding. The draft gives no rule for establishing revision and item equivalence across two independently confirmed bindings. Matching checklist text alone could carry a delegated confirmation across an owner edit that restored the original wording. Preserve the source conversation, binding HLC and item identity on each attestation. Require a verified mapping to the canonical revision before pooling evidence, and route unresolved equivalence to the owner. Test an edit-and-revert alongside an unchanged linked binding.

## Convergence verdict

Convergence failed at the Tier 2 cap for the complete Spec B. A per-member decision and recovery protocol must be reviewed before the canonical project cutover can acknowledge writes. The independent job observation and dry-run inventory are appropriate for a separately scoped reviewed increment; this draft grants no authority to build or enable the remaining migration and automation.

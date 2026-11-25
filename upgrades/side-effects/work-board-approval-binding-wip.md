# Side-Effects Review — Work Board approval record binding checkpoint

**Version / slug:** work-board-approval-binding-wip
**Date:** 2026-11-24
**Author:** Echo
**Second-pass reviewer:** independent Work Board approval reviewer

## Summary of the change

Tier 2 project checkpoint. Work Board approval records can preserve an exact generation binding. Durable journal readback reconstructs the event from the actual stored fields instead of depending on a caller's remembered request. The enabled production writer and slip routes are still absent.

## Decision-point inventory

- Work Board replicated schema — add validation of a present approval binding for an approval put whose recomputed generation matches the record ID.
- Journal receipt evidence — use the exact validated fields to recover the approval proof, version and winning source.

## 1. Over-block

Existing records omit the new binding and keep the existing schema behavior. A new record with a malformed binding or mismatched stable ID fails schema validation. A malformed row cannot provide an exact winner or a proof of absence.

## 2. Under-block

The schema establishes shape and binding consistency, not authorized authorship. The enrolled production writer must be proved at append and projection, and its durable event must match the authoritative decision source.

## 3. Level-of-abstraction fit

The store schema owns record validation. The journal readback owns durable evidence. The policy and exact owner-device proof belong to the production writer and slip authority.

## 4. Signal vs authority compliance

[Signal vs Authority](../../docs/signal-vs-authority.md). The deterministic schema authenticates no person. It preserves exact fields for the existing owner-authorized production boundary to evaluate.

## 4b. Judgment-point check

No new static heuristic for a competing-signals judgment. Record type, typed version and deterministic generation are enumerable.

## 5. Interactions

- **Shadowing:** legacy approvals do not contain the optional field.
- **Double-fire:** recovering a present binding returns the exact deterministic record identity and does not emit or acknowledge a new event.
- **Races:** the enrolled writer is still responsible for the reservation and current-proof check.
- **Feedback loops:** the codec adds no pickup or journal emission.

## 6. External surfaces

No client or approval route change in this checkpoint. Future receipt generation requires a production writer that emits the bound record.

## Verification

Focused unit tests include a mismatched-generation regression. The real Work Board journal fixture emits an approval binding and reconstructs it from durable validated journal data.

## Independent second pass

The reviewer concurred with checkpointing after confirming the binding survives real durable readback and that boot rebuild and live projection both exclude bound records or the reserved event namespace. The receiver must prove the enrolled writer, and the applied tap must match its exact owner proof and material version, before enabling the projection path.

## Outer tap binding

The generation now includes the material and title hashes used by the existing Work Board tap. The decoder compares both with the durable outer record and refuses a mismatch. Legacy events still omit the optional binding, and writer-bound events still cannot reach the legacy fold. Regression tests cover changing either outer field while preserving the recorded binding.

## Owner and proof binding

The generation now includes the enrolled owner’s person key. The decoder requires the same person on the outer tap, with PIN proof for console or bulk and presence proof for phone or slip. The independent reviewer concurred. These checks establish consistency of the durable event. The production gate still owns verification of the original authentication.

## Server card snapshot

WorkBoardService now derives a detached disclosure and exact version from cards that still await approval. The snapshot binds card and policy history, the selected disclosure, and the existing material and title hashes. It is internal and does not grant approval. The independent reviewer concurred. Production routing must apply the normal authorization and show the exact selected disclosure.

## Bound journal append

WorkBoardService can now accept an in-process, owner-authenticated exact approval when an authority adapter is supplied. It rechecks the current writer proof, owner and card version, then enqueues the bound event without applying the legacy fold or invoking its local write observer. No production caller supplies the adapter yet. The result refers to the journal decision and cannot be shown as proof of card projection. The mounted paths must wait for the enrolled writer and durable projection gates before using it.

The service reserves the event ID before enqueuing it. A timeout, missing sequence or unproved emit outcome leaves that reservation in force for the process lifetime unless exact durable readback resolves it. Recovery on restart still needs the complete enrolled journal and writer proof.

## Server presence-signing fixture

The server builds a distinct finite-slip action line using the existing owner-device presence envelope. The shared fixture checks byte-for-byte parity with the iPhone implementation and rejects noncanonical UUID or digest strings. Existing routes remain unchanged. Challenge issuance, authentication, and consumption stay with the owner-device authority when the new action is mounted.

Independent review reproduced the shared fixture digest and concurred with the dark checkpoint. The helper rejects non-string inputs before constructing the signing line.

## Durable slip decisions

The store saves one immutable ordered slip per authenticated source and records one exact decision per slip in an immediate SQLite transaction. The decision, source, proposal digest, and current writer must match. An unsigned expired slip refuses a decision. An exact committed replay returns the same record. Digest, canonical shape, and source identity are verified on read, and persistent database handles require a durable journal mode. Routes must authenticate source and owner proof before calling the store and must verify the currently enrolled writer and sealed history before applying the recorded decision. The store checkpoint has no live call site. Tests cover integrity, expiry, source deduplication, decision replay, and reopening a persistent database.

Independent review concurred after sealing the exact slip ID and expiry together with the canonical proposal. Tests cover malformed and changed stored deadlines and a real database reopen. The production authority must distinguish committed receipt recovery from fresh application.

## Per-card application claims and results

Recording the signed decision and inserting its pending item rows occur in the same SQLite transaction. The enrolled application adapter must claim each exact item before invoking the writer. A claim cannot be taken again, including after a reopen. An incomplete claim appears unresolved. A completion must match the recorded claim, and a winning event must match that exact signed card generation. Results are returned in the signed order. The caller still owns current enrollment, verified presence, and journal proof for every asserted winner. This store has no production caller.

Independent review concurred with the per-card state transitions. The 24-hour deadline also bounds new claims. Exact completion of an already claimed item can still record its durable receipt after expiry. Production claims require fresh enrolled writer proof from the adapter.

## Apply a signed slip

The internal application adapter reads the signed decision, claims items in order and supplies the exact stored version to the approval writer. It checks the enrolled writer before each claim and after each asynchronous result. It accepts an applied or independent winner only when the proof and version match the signed item and the production projection adapter confirms the exact event. An uncertain result remains claimed and is never retried blindly. The adapter has no production caller.

The loop snapshots the decision and writer proof on entry and preserves the validated winning event ID across asynchronous observation. Projection confirmation is read-only. Regressions exercise a caller changing its decision during application and a winner generated for a different version.

## Signed owner-device disclosure and receipt read

The mobile Work Board read now checks the signed owner-device scope at admission, rejects bearer access at the route, and delegates to the enrolled Work Board runtime. The runtime checks the current writer before and after its read, returns ordered disclosure and receipt data with no-store, and keeps the authenticated source and decision reference internal. No production enrollment is supplied. Independent review concurred with the dark route. The real AgentServer lifecycle test covers signed owner access, bearer refusal, a signed pending-item receipt, and loss of writer proof. Before live enrollment, the issuing adapter must construct the typed disclosure only from vetted owner-visible card snapshots and prove signed non-owner and linked-browser rejection.

## Scoped owner-device presence challenge

The existing mobile challenge route now recognizes the finite Work Board slip action. It binds the slip ID, exact disclosure and expiry, enrolled writer and owner, signed device, host, and presence-key fingerprint. It caps challenge expiry at the slip deadline. This specific owner-phone action can request a challenge without a console PIN. All existing secure transport, active owner device, enrolled presence and permission feature checks still apply. Existing actions keep their current policy. The independent reviewer concurred with the checkpoint. A future submit route must rederive the binding and verify the single-use presence challenge before it records the durable decision. No submit or production enrollment is supplied here.

## Owner-device approval submission

The signed owner-phone submit rederives the current slip, writer and device binding, verifies the existing presence signature and consumes the live action challenge before recording a decision. The durable decision ID hashes the challenge with a slip-specific domain. An exact signed retry still needs current binding and valid presence proof, and only reads the receipt. The independent reviewer concurred. The lifecycle fixture checks old-key rejection, invalid signature refusal, one durable signed decision and identical retry. The server reports pending items here. No production enrollment or application call is supplied by this checkpoint.

## Opt-in runtime application

The Work Board runtime now runs the ordered application adapter after a fresh verified slip decision when an enrolled application port is supplied. The same current-writer resolver checks the board is started and enabled and the enrolled owner is still current for binding, enqueue, receipt and application. After the asynchronous submission the route verifies the same current owner device, host and presence key before returning any private receipt. Exact retry remains receipt-only. Independent review concurred. The real-server fixture uses the real writer and journal, records one bound event, leaves the card unresolved without verified projection, and proves retry does not repeat the append. No production enrollment or projection adapter is supplied.

## Durable approval projection

The opt-in writer now admits one exact validated durable journal record to the board fold after rechecking owner, writer, source, decision, local journal origin, and the exact current card and policy predecessors. The legacy journal apply and rebuild still exclude the reserved record namespace. An already projected event does not reapply on receipt replay. A receipt whose event is absent from the current board index reads unresolved, including after an unverified rebuild. Independent review concurred with the test-only enrollment. Startup recovery, deterministic transcript projection, and production enrollment and peer fencing still require their own evidence.

## Approval conversation history

After the exact durable approval reaches the board, the runtime uses the standard Work Board transcript formatter and credential guard to record one line under the winning event's deterministic transcript ID. It targets the card's existing conversation and skips redacted cards. Retry stays receipt-only. A failed history append does not undo the board event or stop pickup. The real owner-device lifecycle test checks one line in the correct conversation after submission and retry. Recovery of missing history after a restart or later conversation creation still needs the enrolled reconciliation path.

Independent review verified that the line uses the existing event ID deduplication and only the standard approval text. Both formatting and append are best-effort so a lookup or write error cannot turn a durable board approval into an unresolved item.

## Recovery at startup

When an enrolled runtime starts, completed slip results are candidates for read-only journal verification. The runtime rechecks current writer proof and exact card version, then restores the same durable board event and its deterministic conversation line. It never claims a pending item, verifies a new signature, or appends another approval. Strictly later pickup records can remain in the history while recovery verifies the exact earlier predecessor. A later card edit, tap or policy change that prevents verification leaves the receipt unresolved. A restored board event may make its existing pickup cause runnable under the normal pickup rules. Independent review concurred with exact-predecessor recovery in the opt-in test runtime. Before production enrollment, verify chronological recovery after later legitimate journal activity and prove pickup fencing across a full process restart.

## Issue a slip from an exact owner request

The runtime now accepts only a trusted resolver's explicit ordered list from the current owner. It rejects malformed or duplicate card identifiers, derives new disclosure and version data from cards still awaiting approval, and rechecks the writer before it records a new slip. A retry for the same ordered source returns the original sealed slip even after a card edit. A changed list or different owner refuses. Independent review concurred. The real-server fixture uses the runtime issuing path instead of seeding a slip directly. The production provenance resolver and chat posting integration remain unwired.

## Check the recorded Telegram owner request

The Telegram source resolver reads an exact topic and message coordinate from a trusted journal adapter. It requires the configured owner identity and direct human provenance and excludes forwarded, relayed and unclassified messages. The accepted explicit card-list grammar preserves order and refuses duplicates and extra text. The source digest binds the exact recorded text without retaining it in the slip. The store seals that digest, and source mutation refuses an issuance retry. Independent review concurred. Unit tests verify the resolver's refusal cases, and the real-server fixture passes the recorded owner source through complete slip issuance. No live Telegram reader is connected to a production enrollment.

## Agent proposal endpoint for a recorded owner request

The server now mounts a root-agent authenticated proposal route. It uses the existing Telegram journal reader and requires the configured Telegram owner to match the current Work Board owner's linked identity. The known topic and exact message are checked before issuance, and the response contains only locator metadata. The endpoint grants no card authority and enqueues no approval. Agent awareness explains how to use it. Independent review concurred with the dark checkpoint. The real server fixture uses a recorded-message test adapter and legacy owner registry. Live Telegram authorship and Team Access linkage remain activation checks.

## Chat link locator

The locator codec uses a fixed Instar host and a versioned fragment containing a canonical HTTPS agent origin and UUID slip ID. It rejects credentials, non-origin URLs and alternate outer paths or fields. It makes no network request and carries no credential, decision or authority. Native code must check the origin against its existing pairing before any signed read. The server never derives a target from an inbound Host header. This checkpoint adds no link emission or website configuration. Apple associated-domain coverage and a signed real-device open remain activation checks.

## Enrolled journal writer fence

Every local Work Board journal mutation under the slip runtime now requires the current enrolled writer both before emit and inside record building. The builder also verifies its local origin and refuses an unbound or wrong-writer approval. Partial enrollment without an application adapter leaves slips and Work Board writes unavailable. Legacy boards without slip enrollment keep their current behavior. Independent review concurred. The real-server fixture checks lost writer and zero journal mutations, legacy approval refusal on the enrolled board, and partial enrollment refusal. Peer record admission and ordinary versioned client wiring remain separate activation requirements.

## Peer journal admission and pickup fencing

An enrolled runtime admits local records from trusted machine metadata and exact peer records whose fingerprints are present in the sealed enrollment history. An unexpected or unattributed record fences the runtime before applying that batch. The fence prevents later local writes and stops pickup at both the next pass and downstream dispatch or stop delivery. Legacy boards keep existing replication behavior. Independent review concurred. The lifecycle tests cover an exact sealed peer row, an unexpected peer edit, and an unexpected peer record arriving while pickup awaits its durable intent. Production proof of the sealed baseline and old-build refusal remains required.

## Sealed peer history completeness

The enrolled writer now checks that every sealed peer record is present in a full journal load. Missing records fence the same writer authority as unexpected records. Incoming deltas still use membership checks because each delta carries only a subset of the board.

- Over-block. A temporarily incomplete peer stream leaves the enrolled board unavailable until the writer state is verified again. The fence persists through an in-process stop and start.
- Under-block. The check covers the exact peer record set supplied by enrollment. Production enrollment still has to prove that set and the local writer journal boundary.
- Abstraction and authority. The runtime's existing writer admission uses the exact proof supplied by enrollment. Availability probes and settings do not supply authority.
- Interactions and surfaces. The check runs on full rebuilds before folding the journal. It adds a diagnostic reason and uses the existing unavailable behavior. Legacy boards and incremental replication retain their prior handling.
- Multi-machine posture. The enrolled writer validates the baseline from its replicated journal union.
- Rollback. Keep production enrollment off while changing the check. An enrolled board with unexplained journal loss needs verified recovery before it resumes writes.

Independent review concurred after correcting the lifecycle fixture. Production enrollment must distinguish a verified empty peer baseline from absent evidence.

## Explicit empty baseline

Missing baseline evidence now keeps an enrolled writer unavailable, even when its application and writer assignment exist. An explicit empty set still allows the writer to start with zero peer records. Legacy boards keep their existing path.

- Over-block. A partial application configuration cannot write until enrollment supplies a baseline.
- Under-block. The runtime trusts the enrollment boundary to prove the supplied set and cannot authenticate how it was assembled.
- Abstraction and authority. The existing writer gate consumes explicit enrollment evidence. A missing input cannot infer authority from the absence of journal records.
- Interactions and surfaces. A partial setup yields the existing unavailable response. Journal folding and writer acquisition share the same requirement.
- Multi-machine posture. A verified empty baseline remains valid only for the enrollment that attests to it.
- Rollback. Keep production enrollment off if evidence cannot be supplied. Legacy boards require no migration.

Independent review concurred. The lifecycle fixtures distinguish missing baseline evidence, missing application wiring, and an explicit empty baseline.

## Dark rollout candidate on current main

The enrolled runtime revalidates exclusive ownership of the existing agent-home instance lock before authorizing a writer operation. The explicit second-instance override still works for its current callers and supplies no Work Board writer proof. Production startup has no enrollment. A lifecycle fixture produces a real journal batch through the legacy Work Board path and verifies that the enrolled runtime fences before applying it.

- Over-block. Losing the lock disables slip reads and writes and blocks further enrolled board mutations. This is the required failure state.
- Under-block. The legacy fixture exercises the existing protocol in-process. Fleet admission and a mixed-binary rollout still require evidence before activation.
- Abstraction and authority. The existing lock owns exclusive-process proof. The writer combines it with the existing enrollment and owner proof.
- Interactions and surfaces. The new method leaves existing lock callers on their current contract. The dark routes report unavailability and legacy boards continue to work.
- Multi-machine posture. The lock covers the enrolled agent home on its assigned machine. The sealed journal and epoch constrain foreign records independently.
- Rollback. Keep enrollment off while restoring the prior release. No production slip state is created by this candidate.

Independent review concurred for the dark candidate. A second-instance override can still boot beside the normal holder while the latter's lock continues to validate. Production enrollment must prove that a same-home override or an older binary cannot emit enrolled board writes. The legacy fixture proves receiver refusal at the runtime callback using a real journal batch. A two-binary sync and sender-admission check is still needed for activation.

## Starting-history verification and journal sync

The verifier compares the local projection against an independently attested digest from the frozen fleet and checks the assigned writer's exact durable journal head. The agent-home lock and stream fingerprint must agree before and after the read. It returns the sealed peer set only when these checks pass. The server and verifier now share the same projection loader. The lifecycle fixture exercises a real journal sync append before the enrolled runtime's refusal.

- Over-block. Verification refuses moving streams, partial peer reads, missing own sequences and changed digests. A retained own stream without the full sequence history requires a separately verified restoration procedure.
- Under-block. A locally readable projection alone cannot establish fleet completeness. Enrollment must obtain the expected digest from the frozen accepted fleet and independently prove sender admission, including same-home override.
- Abstraction and authority. The verifier checks enrollment evidence. It neither chooses the accepted fleet nor grants writer authority.
- Interactions and surfaces. Production startup continues to read the same union. The new verifier has no enrollment endpoint and makes no writes.
- Multi-machine posture. The digest binds the full folded projection, including its origins. The returned peer set is specific to the enrolled machine and current starting history.
- Rollback. Existing production layouts require no migration. Leave enrollment off if the verification fails.

Independent review concurred for the dark follow-on. The digest attests the effective folded board projection. It does not attest every historical payload byte or replace independently verified fleet coverage. A first lifecycle run exposed that a valid empty directory has an empty stream fingerprint. The verifier now reserves null for an unreadable or moving fingerprint.

### Separate-build evidence

The lifecycle test accepts `INSTAR_TEST_LEGACY_WORK_BOARD_DIST` and `INSTAR_TEST_CANDIDATE_WORK_BOARD_DIST` pointing to independently compiled package outputs. With the first set, a separate Node process runs the older Work Board to produce the durable legacy batch received by the candidate. With the second set, a separate process from the candidate build attempts lock acquisition with the second-instance override while the current process holds the same-home lock. It must report an override without exclusive authority, while the holder stays exclusive. The default suite still exercises the in-process legacy producer without requiring staging builds.

This proves the receiver refuses effects from an older release and the candidate denies exclusive proof to the override. It does not prove sender protection in an older binary. A production rollout must exclude any older process from write-capable enrollment and from the enrolled home before activation.

Independent review concurred. The nine-case lifecycle run used legacy build `3e318c9236c29df1bd93bb6051557fcdfe16efee` and candidate build `b8fe7d4fdfa92058d5d265f7967fca4d31ef408b`.

## Capture window and sender pause

The existing Work Board enable setting now reaches the journal sender and final pickup delivery check. A live pause blocks new reservations and dispatch while preserving replication. The read-only capture command refuses a changing stream or a local sequence that differs from the separately observed durable advert.

- Over-block. The existing pause intentionally makes Work Board mutations unavailable during capture.
- Under-block. Older already-running binaries need a managed drain and a paused restart. The capture does not enforce production process isolation.
- Authority and interactions. The existing local configuration owns the pause. The capture produces receipts and never grants enrollment or changes a service.
- Multi-machine posture. All active homes pause and catch up before comparing digests. Old-process evidence comes from the supervisor and inventory.
- Rollback. Restore the original setting presence and value through the planned restart and verify normal health.

Independent review concurred with the dark code and capture command. The runbook requires already-admitted pickup and dispatch to drain on all builds. The legacy fixture exercises the compiled startup predicate. The production supervisor receipt remains required.

## Host-local verified owner receipt

The capture command reads an already-open running Team Access log over loopback using the local agent bearer. The route does not instantiate the log, repair files, bind devices or fall back to a profile. It emits the verified owner key and stream metadata only. A missing log, unhealthy log, missing owner, or unresolved gaps prevent a ready receipt. The capture checks single-origin gaps as well, outside the serving policy’s relaxed single-origin handling.

- Over-block. A host that has not opened its verified log cannot participate in the capture.
- Under-block. A healthy receipt does not prove that every peer is caught up. The comparison still requires all accepted hosts and matching pre- and post-capture heads.
- Authority and interactions. The signed Team Access fold is the sole source of the owner. This read does not enable enrollment or confer permission.
- External and multi-machine posture. The endpoint rejects forwarded and browser-origin requests and is specific to the running local daemon. It exposes no signed rows, device keys or invite data.
- Rollback. Keep the capture gated if the endpoint is unavailable. Deploying the previous binary removes the command path without touching the log.

Independent review concurred after adding strict one-origin gap checking, without changing the ordinary serving policy. Fleet receipt comparison is required even when each local receipt is ready.

## Offline fleet receipt comparison

The comparator checks the exact supplied roster, independent frozen heads, both owner snapshots and each folded-history receipt. A successful result prints only the matched machine IDs and the projection digest and origin count.

- Over-block. Missing, incomplete, inconsistent or malformed receipts fail the comparison and leave enrollment unavailable.
- Under-block. Matching files alone do not prove that they were collected from the accepted fleet or that all writers were paused. The runbook keeps those checks with the operators who observed them.
- Authority and interactions. This command compares evidence and cannot change any server or establish an enrollment.
- Multi-machine posture. Inputs are private per-home receipts. Only their comparison summary needs to leave the evidence directory.
- Rollback. The comparison is read-only. A bad result requires restoring writers per the runbook and discarding the capture.

Independent review concurred after confirming the producer’s exact empty digest and bounding known origin counts by their frozen sequences.

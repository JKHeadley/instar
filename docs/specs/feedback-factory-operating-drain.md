---
title: "Feedback Factory Operating Drain"
slug: "feedback-factory-operating-drain"
author: "Instar-codey"
eli16-overview: "feedback-factory-operating-drain.eli16.md"
review-convergence: "2026-07-20T17:03:15.423Z"
review-iterations: 10
review-completed-at: "2026-07-20T17:03:15.423Z"
review-report: "docs/specs/reports/feedback-factory-operating-drain-convergence.md"
cross-model-review: "codex-cli:gpt-5.5 + gemini-cli:gemini-3.1-pro-preview"
approved: true
ships-staged: true
rollout-disposition: active
rollout-source-pr: 1531
rollout-flag-path: feedbackFactory.drain.enabled
rollout-criteria: "At least one operated drain run completes without an authority, integrity, or consumer-liveness failure in each evidence window."
rollout-evidence-type: endpoint
rollout-evidence-ref: /feedback-factory/drain/status
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"completed-drain-runs","source":"feature-summary","sourceRef":"feedback-factory.completed-runs","direction":"at-least","threshold":1,"minSamples":1}]}'
approved-at: "2026-07-20T16:53:14.000Z"
approval-note: "Operator approved with frontier-model Instar agent as default readiness authority and human approval as escalation-only."
parent-principle: "Canonical Pipeline Operational Completeness — Accepted Intake Must Drain"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Feedback Factory Operating Drain

## Problem statement

The canonical feedback pipeline receives fleet reports and clusters them, but it does not operate end to end. `FeedbackProcessingService.processNow()` deliberately stops after `unprocessed -> processing` and states that dispatch is not invoked. A live development machine can therefore accumulate thousands of processed reports and hundreds of clusters while `dispatchCount` remains zero. Another development install can return 503 because the processing feature follows an unregistered development-agent gate and its effective `developmentAgent` identity is false or absent. The current job treats that 503 as a reason to exit silently.

This is not only an instance wiring bug. The missing standard is **Canonical Pipeline Operational Completeness**: a canonical pipeline is not complete merely because every stage exists or its first stage runs. It must have a registered owner and executable, observable, bounded transitions from accepted input to its declared terminal handoff. The process gap is that reviews and tests proved ingest and clustering in isolation, while no structural guard required a canonical pipeline manifest, an operated drain, or an end-to-end liveness fixture.

The build must close the class before fixing the instance: register the standard, add a structural pipeline-completeness guard, then make the feedback factory drain eligible clusters into durable work that is actually consumed.

## Existing system and evidence

- `InboxDrainer` writes canonical `unprocessed` feedback rows.
- `FeedbackProcessingService` reloads that store and clusters rows, changing them to `processing`.
- `JsonlFeedbackStore` already persists feedback, clusters, and dispatches.
- Dispatch create/list handlers and a downstream `DispatchExecutor` already exist, but the clustering service never invokes the handoff.
- The built-in `feedback-factory-process` job only calls the clustering endpoint and explicitly exits silently on 503.
- `feedbackFactory.processing` is absent from `DEV_GATED_FEATURES`, so the conformance wiring test does not protect its intended live-on-development posture.

## Goals

1. Register Canonical Pipeline Operational Completeness as a real standard.
2. Add a structural guard that rejects a declared canonical pipeline lacking a bounded executable path from ingress through its terminal handoff, including runtime wiring and an end-to-end fixture.
3. Make the feedback factory drain eligible clusters into durable, idempotent work records and prove a consumer claims and advances them.
4. Make development-agent operation explicit and structurally tested; fleet remains dark until promoted.
5. Expose useful backlog, readiness, drain, claim, failure, and age metrics without leaking report content.
6. Give the registered frontier-model readiness agent authority over bounded readiness decisions while preserving legacy curator authority over `Cluster.status` and all terminal product-outcome claims; human authority is escalation/break-glass only.

## Non-goals

- Automatically publishing guidance to fleet agents.
- Automatically declaring that a fix shipped or worked.
- Replacing the existing dispatch delivery system or GitHub/project implementation workflow.
- Letting similarity scores decide that a cluster is ready for work.
- Enabling the drain fleet-wide in this increment.

## Proposed design

### Implementation sequence inside the single landing

The operator requested one end-to-end merged PR, so the work is not split into partially operating releases. It is built and reviewed in three gated commits: A) agent-governed readiness, minimal SQLite outbox, Initiative handoff, and real lifecycle E2E; B) narrow manifest coverage guard plus operated cadence/metrics; C) source-generation reconciliation, backup/failover, security, and performance hardening. Each commit has its own tests, but merge is allowed only when all three are green; no intermediate commit is deployed as a claimed operating drain.

| Step | Authoritative write | Result |
|---|---|---|
| accept/project | immutable JSONL generation, then projection+tail cursor transaction | feedback visible exactly once |
| cluster/review | cluster projection and due-review index | governed `collecting`, `ready`, or `held` |
| enqueue | readiness + unique outbox work transaction | one queued work id |
| consume | fenced claim, Initiative write/read-back, link row | one readable Action artifact |
| settle | token+epoch acknowledgement | completed handoff or explicit retry/dead-letter/hold |

### 1. Canonical-pipeline manifest and structural guard

Add `docs/canonical-pipelines.json` with one entry per canonical pipeline. Each entry declares:

- stable pipeline id and owner;
- ordered stages;
- ingress constructor/wiring citation;
- transition implementation citation for every edge;
- persistent state and idempotency key for every mutating edge;
- terminal handoff and named consumer;
- cadence/trigger citation;
- metrics/readiness citation;
- an end-to-end fixture that starts with accepted input and proves the terminal consumer receives or advances the handoff;
- rollout posture and rollback switch.

Add `scripts/lint-canonical-pipeline-completeness.mjs` as a **structural coverage guard** and wire it into repository lint/CI. Extend the closed route-group/capability registries so every accepted-intake POST/PUT/PATCH route and every ingest job must declare a typed `canonicalPipelineId` or `nonCanonicalReason`; every downstream constructor exports typed `{ canonicalPipelineId, stage }` metadata and the manifest cites that symbol. AST lint fails an intake handler/job/stage lacking this registry value. Comments may explain citations but never establish membership. Reviewed exclusions are committed with owner/reason/expiry. The hard mechanical gate is intentionally narrow: typed registry coverage, declared owner, terminal handoff/consumer citation, and CI collection of the named runtime smoke/E2E. Cadence behavior, idempotency effectiveness, and runtime progress are proven by constructed smoke tests, lifecycle E2E, and metrics—not inferred by AST lint. Semantic claims remain review-authoritative. Negative fixtures include an unmarked accepted-intake route. Fixture existence alone never proves liveness.

Register `feedback-factory` first, covering receive -> persist -> cluster -> eligibility -> durable work -> consumer claim. This closes the whole class for future canonical pipelines rather than special-casing two files.

The lint emits **coverage evidence**, never a claim of semantic completeness. Every manifest entry also names a collected runtime smoke contract that constructs the real route/job/consumer graph and proves one bounded positive-control transition; semantic review and the full lifecycle E2E remain authoritative. A fixture whose manifest claims real operation must use the production consumer adapter and authoritative read-back store; substituting a mock/no-op terminal consumer makes the positive-control fail.

### 2. Separate classification from readiness authority

In plain language: a report becomes part of a cluster; a registered development agent reviews whether that cluster contains enough coherent evidence to justify owned work; one queue row creates one Initiative task; and queue completion means that task exists and is readable, not that the underlying product problem is fixed.

Clustering is signal production. It may propose a cluster, merge reports, and compute priority/evidence, but it cannot authorize external work by itself.

Introduce a durable `readinessState` that is strictly separate from the existing curated `Cluster.status` product lifecycle. The drain may never mutate legacy `status`, recurrence, reopen, partition, parity, or immutable-import fields. Imported and existing clusters project to `readinessState: collecting`, `readinessEpoch: 0`; readiness history records actor, authority evidence, prior/next state, epoch, and time.

- `collecting`: more reports may merge; not eligible;
- `ready`: a registered frontier-model Instar readiness authority (or an explicitly invoked human escalation authority) has approved creation of a work item;
- `queued`: one durable work item exists;
- `held`: operator hold or invalid/corrupt state.

Readiness has only `collecting | ready | queued | held`. Claim/retry/completion is derived from the uniquely linked work row. Product `resolved` remains exclusively in legacy `Cluster.status`.

Existing clusters import as `collecting`. No historical cluster is auto-promoted merely because it is large, old, or highly scored. The default readiness authority is a registered Instar agent using a frontier model through the repository's intelligence-provider/routing registry. The arbiter receives only a bounded, scrubbed evidence packet with enumerated candidate ids and output choices; it must return a schema-valid decision of `ready | collecting | escalate-human`, confidence, reason codes, and cited evidence ids. The deterministic floor rejects empty, corrupt, held, over-batch, stale-evidence, untrusted-instruction-bearing, or authority-mismatched candidates before the model runs. `held` is not a model output: only deterministic integrity rules or the explicit human break-glass path may impose it. The conservative fallback for timeout, parse failure, injection suspicion, unavailable frontier routing, low confidence, or disagreement is `collecting` or `escalate-human`, never `ready`.

Readiness authority is registered, not implied by being an agent. A closed `feedback-readiness-authorities.json` registry is rooted in operator-ratified configuration: only the PIN-bound operator mutation surface may create, replace, revoke, or restore an authority record. The runtime agent and model may never self-register, widen their batch/spend envelope, clear revocation, or replace the authority root. Each immutable-versioned record binds agent id, machine/owner epoch, resolved provider/model family, prompt and schema versions, decision-point id, maximum batch/token/daily-spend envelope, created/revoked/restored decision references, and registry generation. Every mutation appends a checksummed audit row and invalidates older generations; runtime rejects missing, self-authored, stale-owner, stale-generation, revoked, model-mismatched, or envelope-exceeding authority before inference. Backup/restore includes the registry and audit chain.

The decision record binds the active authority generation to the evidence-set hash and nonce. The model judges whether the bounded evidence supports creating development work; it cannot select arbitrary ids, routes, commands, artifact keys, or authority. Every decision is provenance-recorded with identity-only envelopes—raw report bodies, prompts, model output, and transcripts never enter decision provenance. Prompt/version canaries and injection-exposure coverage are mandatory. Duplicate approval keys return the existing decision; conflicting authorities or evidence drift trigger a deterministic integrity hold and escalate.

Agent approval is the normal operated path, in proposal-set-bound batches of at most 50, with per-tick and daily spend brakes. Human PIN approval is an optional escalation and break-glass path for ambiguous evidence, repeated arbiter disagreement, integrity repair, or explicit operator intervention; it is never the default throughput chokepoint. With the characterized 149-cluster backlog, the initial objective is three or fewer agent-reviewed packets and oldest candidate review within 24 hours. The canonical development agent owns that SLO; overdue state first self-heals routing/cadence boundedly and then raises one attention. Readiness quality is continuously measured against later artifact outcomes and any human-settled escalations. Authority is automatically demoted to proposal-only on unauthorized promotion, schema/provenance failure, duplicate-rate breach, precision regression, spend-brake trip, or prompt/model canary drift; restoration requires a new registered authority record. This makes autonomous agent judgment the class default while retaining a narrow human exception.

This judgment is not reduced to a deterministic readiness score because cluster evidence contains competing semantic signals: distinct symptoms may share tokens, a high-volume cluster may be noise, a small cluster may expose a severe invariant break, and apparent duplicates may require different work. Deterministic rules remain the safety floor and exact transition authority; the frontier model resolves only that bounded competing-signal question. A deterministic policy may later replace the arbiter only after it demonstrates equivalent decisions on the same evidence contract and is registered through the same authority root—never by silently converting similarity or volume into actuation.

“Must drain” means every accepted intake advances to either a consumer handoff or an explicit observable governed waiting/terminal disposition; it does not mean noisy input autonomously actuates work. `collecting` is therefore a named waiting disposition with `enteredAt`, `lastEvaluatedAt`, `nextReviewAt`, reason code, and oldest-age SLA. A separate indexed due-review scan keyed `(nextReviewAt, clusterId)` reevaluates at most 100 oldest-due collecting rows per tick; it uses a wraparound cursor, commits each bounded page transactionally, and leaves failed rows due for retry. Due count, oldest overdue age, scan lag, and last successful evaluation are metrics. `held`, `dead-lettered`, and completed handoff are explicit terminal/operator dispositions. No row may disappear into an unmeasured manual queue, and readiness authority does not waive the review-age SLO.

### 3. Durable work queue and transaction authority

Add one SQLite/WAL `feedback-drain.db` as the transaction authority for readiness projections, work, leases, run state, artifact linkage, and audit. The existing canonical JSONL remains source evidence and clustering storage; the drain does not attempt multi-file transactional semantics over it. SQLite is chosen over another JSONL queue because uniqueness, compare-and-swap fencing, crash atomicity, and multi-process tests are required; an external broker is rejected because the operated development volume is bounded and Instar must remain self-contained/offline-capable.

The DB and WAL live on local disk of the canonical operated host only; network/shared filesystems are forbidden. Planned failover requires the old owner stopped, a checkpointed DB/WAL snapshot copied with manifest checksums, checksum verification on the target, restore plus `integrity_check`, and then an authority-epoch bump before opening the writer. Unclean failover preserves both copies and follows the split-brain recovery path; it never mounts one DB concurrently from two hosts.

This is deliberately a minimal transactional outbox plus worker loop, not a general workflow engine: one readiness projection, one work table, one lease table, one run table, and one artifact-link table with closed transitions. A plain job-queue table without the outbox transaction cannot atomically bind readiness to work; the existing task store cannot fence the cross-store artifact write; an external/Temporal-like engine adds deployment and network authority for one local bounded consumer. New arbitrary workflows, DAGs, user-defined steps, and generic orchestration APIs are non-goals.

| Alternative | Decision |
|---|---|
| Existing Initiative/task store alone | rejected: no atomic readiness outbox or fenced cross-store artifact acknowledgement |
| Generic SQLite queue library | reuse primitives if compatible, but retain this closed schema/transition contract; library presence cannot supply authority semantics |
| Minimal SQLite transactional outbox + worker | chosen: this design |
| External broker | rejected: adds operated network/deployment authority for bounded offline development volume |
| Temporal-like workflow engine | rejected: DAG/replay generality is unnecessary for one closed consumer |

Implementation reuses the repository's existing SQLite driver, `JobScheduler` cadence, breaker/backoff primitives, BackupManager, and Initiative store. Bespoke queue semantics are limited to five states, one lease CAS, bounded retry/dead-letter, and exact-key artifact reconciliation; there is no generic job payload, arbitrary handler registry, DAG, or workflow API. A third-party SQLite queue would still need these authority/token/link invariants and would add a second scheduler beside `JobScheduler`.

The stable idempotency key is `feedback-work:<clusterId>:<readinessEpoch>` with a unique index. Work creation, readiness `ready -> queued`, and the audit row commit in one DB transaction. Re-running returns the existing work id. All compaction/checkpoint work occurs behind the same writer fence. Crash recovery relies on WAL atomicity; startup runs integrity check and reconciliation before admitting a tick.

Each work record contains only bounded, scrubbed metadata: work id, cluster id, title/summary, priority, report count, first/last seen times, readiness authority/evidence references, state, lease epoch, attempts, timestamps, and outcome references. Raw report bodies, credentials, prompts, transcripts, and user identifiers are excluded.

States are `queued -> claimed -> completed | retryable | dead-lettered | held`. A claim carries `consumerId`, `leaseEpoch`, `leaseExpiresAt`, and a one-time opaque claim token. Only an HMAC/token hash is persisted; plaintext is returned once, compared in constant time, redacted from every read/error/log, and rotated each epoch. Complete/retry operations require the current token and epoch. Lease expiry requeues through a bounded reconciler.

Closed readiness transitions:

| From | To | Actor/precondition | Epoch/idempotency/failure |
|---|---|---|---|
| collecting | ready | registered frontier-model agent authority or explicit human escalation; deterministic floor passes | increment epoch once per authority+evidence approval key; duplicate returns existing state |
| collecting/ready | held | deterministic corruption/integrity invariant or human break-glass authority only; model cannot choose `held` | epoch unchanged; audit reason required |
| held | collecting | registered readiness authority only after the named deterministic integrity predicate revalidates the source/projection/authority invariants, or human break-glass | increment epoch, invalidating prior proposals; failed revalidation remains held |
| ready | queued | canonical drain owner; atomic unique work insert | same epoch; failure leaves ready |
| queued | held | operator/corruption; linked work held | invalidates work lease epoch |
| queued | collecting | explicit supersession/reclassification | increments readiness epoch; old work terminal-held |

Closed work transitions:

| From | To | Actor/precondition | Failure behavior |
|---|---|---|---|
| queued/retryable | claimed | canonical consumer; retry time due; atomic lease CAS | loser receives 409 |
| claimed | completed | current token+epoch; exact user-visible Initiative task readable by work key | remain claimed/retryable |
| claimed | retryable | current token+epoch; bounded attempt available | backoff+audit |
| claimed | dead-lettered | current token+epoch; attempts/wall clock exhausted | operator replay creates new readiness epoch |
| any nonterminal | held | operator or integrity authority | no automatic release |

`completed` proves handoff only. It never sets legacy cluster `status` to fixed/resolved. Later product reopen or artifact unreadability creates an audited `handoff-degraded` observation; it does not rewrite completed history or silently duplicate work.

### 4. Real consumer handoff

The first consumer is the existing user-visible Initiative work intake, not fleet dispatch delivery. One `InitiativeTracker` record with `kind:'task'` is the Action artifact: deterministic id `feedback-<workId>`, `pipelineStage:'outline'`, scrubbed description, cluster/work links, and phases `class-review`, `spec`, `build`, `verify`. It is independently readable/operable through the existing Initiative API, dashboard, and digest; no private TaskFlow row can satisfy handoff. `Initiative`/`InitiativeCreateInput` gain an optional immutable unique `feedbackWorkKey`, indexed with legacy rows backfilled null. Exact-key lookup precedes semantic proposals. A DB linkage row owns the cross-store invariant. The consumer:

- reuses only an exact-key Initiative task; semantic candidates are advisory and ambiguity holds the work;
- derives the deterministic task id and records its successful read-back in the linkage row;
- persist the returned artifact references before acknowledging completion;
- on timeout, reads by exact key before retry; incompatible existing ids/keys hold for operator repair;
- never mark the feedback work completed until the linked artifact is readable back from the authoritative store.

This is an outbox/saga boundary, not a distributed transaction. SQLite is authoritative for readiness, queue, lease, and acknowledgement history; InitiativeTracker is authoritative for whether the user-visible artifact exists. If an Initiative is readable by the exact `feedbackWorkKey` while SQLite remains `claimed` because linkage persistence repeatedly failed, reconciliation treats the artifact as the durable forward fact: it retries the linkage write under the current fence and then acknowledges completion. It never deletes or recreates the Initiative, and a stale claimant cannot settle it. If exact-key read-back is absent, SQLite remains claimed/retryable; neither store may infer completion from the other's timeout.

This makes backlog work enter the normal work system. It does not claim the underlying product fix is complete. Later dispatch guidance can be produced only from evidence-backed outcomes through the existing dispatch authority.

### 5. One operated drain tick

Replace the clustering-only trigger with one server-owned drain tick:

1. acquire the canonical-host DB lease/fence;
2. incrementally project canonical input after the persisted `ingestSequence` cursor;
3. cluster unprocessed feedback;
4. reevaluate at most 100 collecting rows from the independent `(nextReviewAt, clusterId)` due index;
5. scan/enqueue at most `maxReadyScansPerTick: 250` ready clusters idempotently from a persisted cursor;
6. claim up to `maxClaimsPerTick` eligible work rows;
7. invoke the work consumer;
8. reconcile at most 100 expired leases;
9. reconcile at most 500 source-generation records against projection ids/checksums from a persistent wraparound cursor;
10. publish metrics and a scrubbed audit result.

Each stage has a 20-second budget and the full tick has `maxWallClock: 90s`; input clustering is capped at 500 reports/tick. Normal ticks must never reload or rescan the full JSONL. Source discovery uses an append-generation protocol: each immutable source record carries `sourceRecordId` and checksum; a durable sidecar cursor stores `(generationId, byteOffset, lastRecordChecksum)`. The tailer advances that cursor only in the same SQLite transaction that inserts the deduped projection row and assigns its immutable `ingestSequence`. A crash after JSONL append but before projection leaves the cursor at the prior boundary, so replay rediscovers the record; a crash after commit resumes after it. Duplicate `sourceRecordId` with a different checksum is corruption and holds.

Compaction writes and fsyncs a new immutable generation, writes a checksummed handoff manifest binding old generation/final offset/final checksum to the new generation/start checksum, then atomically publishes the manifest. The tailer finishes the old boundary and follows only a valid handoff; source-record uniqueness makes copied live rows idempotent. The old generation is retained until every registered tail cursor acknowledges the handoff. Missing/truncated generation or invalid handoff fails closed—never guesses an offset. Later LWW updates are new source records and receive a new projection sequence. The one-time import/backfill assigns deterministic sequence by receivedAt plus feedback-id tie-break and records the source checksum. Source-byte lag, generation lag, projection cursor lag, and truncation are metrics. Queue/audit history retains 400 days; run detail 30 days; DB WAL checkpoint/pruning is bounded and fenced.

Recurring reconciliation is first-class, not startup-only. It compares immutable source ids/checksums with projection rows in bounded oldest-unchecked order and reports missing projection, orphan projection, checksum conflict, and generation-handoff mismatch counts/ages. Missing projections replay idempotently; orphan/conflicting rows are held with a scrubbed repair packet and never auto-deleted or rewritten. A persistent mismatch exhausts self-heal then raises one operator attention with the exact bounded repair class.

Runs are durable: `accepted -> running -> succeeded | no-op | degraded | failed | abandoned`. A run row holds owner host/epoch, lease heartbeat/expiry, cursors, stage results, and bounded reason. The route returns 202/run id; concurrent triggers return the same active id. Boot marks an expired running row abandoned, reconciles its claims idempotently, then admits a new run. Cancellation stops before the next stage boundary and never revokes an in-flight fenced artifact write.

### 6. Development posture and dark-state repair

Register `feedbackFactory.processing` in `DEV_GATED_FEATURES`. Split flags are `processing.enabled`, `drain.enabled`, `consumer.enabled`, plus durable `consumer-live.json` promotion state (schema/version, approved batch bound, evidence hash, operator decision id/time, revokedAt). Development processing+drain cadence ship live; consumer runs simulation until the PIN-bound `/feedback-factory/consumer/promote` record exists. Simulation runs the exact claim/ack/recovery state machine against an isolated ephemeral simulation DB and a no-op artifact adapter, then writes bounded would-create metrics; it cannot mutate canonical leases, attempts, queue state, retry time, dead letters, or artifacts. Simulation is rollout characterization only and never satisfies the production lifecycle acceptance criterion, which runs the real canonical DB and Initiative adapter. Effective live posture requires config eligibility AND a valid unrevoked promotion record, preventing config-only bypass. A PIN-bound revoke returns to simulation across restart. Fleet defaults all dark.

Add boot/scheduler construction tests and diagnostics that distinguish:

- intentionally fleet-dark;
- misclassified development install (`developmentAgent` absent/false);
- enabled but missing canonical data directory;
- initialization failure;
- live and healthy.

On a development agent, omitted processing/drain flags resolve live and the built-in cadence is installed/enabled. The job must not silently treat development-agent 503 as healthy. Self-heal may only regenerate the typed machine-owned `state/generated-feature-defaults.json` fields `feedbackFactory.processing.enabled` and `feedbackFactory.drain.enabled` when absent or schema-stale; it cannot write `config.json`, `consumer-live.json`, `consumer.enabled`, any operator-authored override, or machine identity. It records a typed before/after diff limited to those two booleans plus schema version, with fixtures rejecting any extra field, restarts once through existing authority only when that migration changed bytes, and rechecks. Fleet-dark remains expected.

### 7. Metrics, APIs, and dashboard

Authenticated read surfaces expose:

- feedback counts by state and oldest age;
- clusters by readiness state and oldest ready age;
- work queue counts by state, oldest queued age, retry/dead-letter counts;
- last successful cluster/enqueue/claim/completion timestamps;
- last drain run, result, duration, and no-progress reason;
- effective gate posture and reason.

Authority-gated lifecycle surfaces handle `ready`, `hold`, and release operations. The default agent path requires Bearer authentication, `X-Instar-AgentId`, current owner-machine/authority-epoch binding, request nonce, registered readiness-authority evidence, and mutation rate limiting. The optional human escalation path requires PIN plus `X-Instar-Request` and CSRF/origin validation. Consumer routes additionally require the current lease token. All responses use closed field allowlists and byte caps. Summary persistence uses `DurableOutputScrubber` and fails closed by holding the work if scrubbing cannot safely complete. JSONL/SQL inputs reject or escape control/newline injection.

### 8. Backlog activation

Historical clusters are loaded as `collecting`. Provide an authenticated backfill analysis that proposes bounded readiness batches using metadata only. The registered frontier-model readiness agent reviews and may approve each bounded batch, after which the normal idempotent drain enqueues it. A human may settle only escalated batches or intervene explicitly. No one-click action may both classify and dispatch the entire historical backlog without a review packet showing counts, age distribution, priority distribution, duplicates, and estimated work-item volume.

## Decision points touched

| Decision point | Classification | Floor / authority |
|---|---|---|
| Is a feedback report assigned to an existing cluster? | judgment-candidate | Existing bounded similarity/classifier output is signal; schema validity and candidate bounds are deterministic; no external actuation follows directly. |
| Is a cluster ready to become work? | judgment-candidate | Deterministic eligibility floor excludes corrupt/held/empty/stale/instruction-bearing rows; a registered frontier-model Instar arbiter is the default authority inside the bounded output space. Conservative fallback is `collecting` or human escalation; human approval is exceptional, not the default gate. |
| May a work row be claimed? | invariant | Queue state, retry time, breaker, lease expiry, and atomic fencing are exact concurrency invariants. |
| Which existing development artifact matches this work? | judgment-candidate | Exact external-key match wins; semantic candidate selection is bounded; ambiguous matches conservatively create no link and hold for review. |
| May a work row complete? | invariant | Current lease token plus readable authoritative artifact reference is required. This proves handoff, not product resolution. |
| Did the underlying feedback cluster resolve? | judgment-candidate | Existing evidence-backed verification authority; queue completion alone is insufficient. |
| Is a dark processing route expected? | invariant | Fleet-dark is expected; development-agent dark is degradation based on authoritative config identity. |

## Frontloaded Decisions

1. The terminal handoff for this increment is a durable development Initiative/Action, not an outbound fleet dispatch.
2. Historical clusters require explicit registered-agent readiness approval; size/age alone cannot actuate work creation, and human approval is only an escalation path.
3. The drain is live on development agents and dark on fleet; the work consumer ships dry-run first, recording exact would-create artifacts before live promotion.
4. Work completion means authoritative handoff exists, not that the product fix is complete.
5. Durable queue state is unified through the canonical operated host; peer machines use authenticated proxied reads/triggers rather than independent competing drains.

## Multi-machine posture

The feedback source store is unified on the configured operated host from `feedbackFactory.operatedHostMachineId` in the machine registry. Readiness/work/run DB is unified there. Every mutation carries that machine fingerprint and monotonically increasing `authorityEpoch`; only the current registry owner can acquire the DB lease. Nonowners proxy with authenticated sender/target ids, nonce, expiry, hop-count 1, and replay cache, or return explicit owner-unavailable—never local fallback. Manual operator failover increments authorityEpoch, invalidates all prior leases/tokens, requires old-owner quiescence or an explicit split-brain recovery packet, and runs integrity reconciliation before draining. Topic movement cannot strand keyed work. Notices use one-voice ownership/dedupe.

Per-machine boot diagnostics and caches are machine-local operational observations only; they contain no canonical decisions and may be discarded. No machine-local justification marker is required because these are ephemeral process observations rather than durable feature state.

## Recovery boundary

Automated recovery for dark-on-development and stalled-drain degradation is deferred to the separately converged reusable `SelfHealGate`/P19 foundation lane. <!-- tracked: slack-topic--1734007126 --> This landing exposes generated-default repair need, unavailable posture, stalled state, and progress age without mutating config, restarting, or re-running a tick. It deliberately contains no feature-local retry workflow. Once the shared primitive lands, feedback-drain may adopt it in a follow-up <!-- tracked: slack-topic--1734007126 --> that declares and verifies the complete Standard-B contract. Corruption, destructive data loss, or authority bypass is critical: perform read-only diagnosis, preserve bytes/checksums, and notify immediately. Automatic config refresh, restart, restore, or drain rerun is prohibited until integrity/authority is operator-restored.

## Security and privacy

- All read/trigger routes require normal agent authentication.
- Readiness and backfill approval default to a registered frontier-model Instar authority with authenticated agent identity, owner epoch, evidence-set hash, prompt/schema/model provenance, nonce, rate limit, and bounded spend; human PIN authority is an optional escalation/break-glass path. Imposing `held` is reserved to deterministic integrity transitions or human break-glass. An agent may release `held` only after the named deterministic source/projection/authority revalidation predicate passes; model judgment alone cannot impose or clear a hold.
- Batch promotion is proposal-set bound: at most 50 work ids, sorted and hashed into `proposalSetHash`; the confirmation surface shows aggregate counts plus every bounded title/priority/id (raw report bodies excluded), and the mutation must present that exact hash. Any item drift rejects the whole batch. Rollback holds the exact promoted set without deleting its rows or rewinding epochs.
- Claim and acknowledge require agent identity and an unguessable current lease token.
- Every response clamps fields; raw feedback content stays out of metrics, logs, queue rows, reviewer prompts, and dashboard summaries.
- Work summaries pass through durable-output scrubbing before persistence.
- A cluster/report supplied from an untrusted source cannot choose an artifact id, consumer id, external key, route, or command.

## Failure semantics

- Input reload/clustering failure: no enqueue or claim; audit and retry boundedly.
- Enqueue failure: cluster remains `ready`; next tick retries with the same key.
- Artifact creation timeout: read by external key before retry; never assume failure means no write.
- Ack persistence failure: authoritative artifact reference lets reconciliation complete idempotently.
- Lease-holder crash: expiry permits a new fenced epoch; stale acknowledgements fail 409.
- Corrupt DB/WAL: stop all mutations, preserve bytes/checksums, and require operator repair/restore. For canonical source JSONL, only a checksummed provably torn final append may be quarantined automatically; mid-file or entity-latest corruption holds the affected transaction/entity family and never rewrites source automatically.
- Consumer unavailable: queue remains durable; breaker stops hot retries and surfaces one degradation.
- No eligible ready clusters: healthy no-op, distinct from stalled progress.

## Rollout and rollback

The first landing requires the whole safe vertical slice: registered standard + manifest/coverage guard, source projection, registered frontier-model readiness authority, readiness/work/outbox tables, one real Initiative consumer, operated development cadence, metrics, and collected production-adapter lifecycle E2E. Promotion beyond simulation, larger historical batches, multi-host failover exercise, and broader readiness-authority enrollment are rollout ratchets over that landed slice; they are not substitutes for missing first-landing correctness.

1. Before merge, fixtures exercise dark and live modes. The shipped development posture is processing+drain cadence live with consumer simulation; fleet is dark.
2. Run development-agent simulation over real backlog; compare proposed work counts and duplicate rate.
3. Operator promotes the development consumer live for a bounded batch through the durable route.
4. Expand batch size only after zero duplicate artifacts, bounded retry behavior, and measurable queue-age decline.
5. Fleet remains dark in this spec.

Rollback disables the drain/consumer flags. Existing feedback, clusters, readiness, queue, and artifact links remain readable and inert. No rollback deletes records or rewinds readiness epochs. The clustering-only path may remain available for diagnosis, but the dashboard must label it “classification only — work drain disabled.”

BackupManager writes one versioned backup manifest at least hourly and after every promotion/failover operation. The set includes `feedback-drain.db` plus WAL/checkpoint metadata, every live or retention-pinned immutable source-generation JSONL file, generation-handoff manifests, tail cursor/checksum metadata, `feedback-readiness-authorities.json` plus its checksummed audit chain and registry-generation metadata, `consumer-live.json`, generated-default posture, and artifact-link rows. The Initiative store remains its separately backed authoritative dependency; restore must read every linked Initiative by immutable `feedbackWorkKey`, holding rather than duplicating any unresolved link. Development objectives are RPO ≤ 1 hour for settled drain state and RTO ≤ 4 hours for operator-restored service. While the canonical host is down, ingress remains durably queued at its existing source but no alternate writer self-elects; backlog age and owner-unavailable state remain visible. Bare-host restore orders source generations/manifests, readiness-authority registry/audit generation, DB/WAL integrity, promotion/default state, then Initiative link reconciliation; it verifies every checksum/read-back, increments authority epoch, and only then resumes cadence. A destructive-fixture positive control removes the entire operated-host state directory, restores this set, and proves no lost projection, authority decision, or duplicate artifact.

## Acceptance criteria

1. The standards registry contains Canonical Pipeline Operational Completeness with a guard citation.
2. `lint-canonical-pipeline-completeness` fails typed-registry fixtures for unregistered intake/stage metadata, missing owner/handoff/consumer citation, comment-only membership, or an uncollected cited smoke/E2E test.
3. A real lifecycle test proves: receive report -> cluster -> registered frontier-model agent-ready -> enqueue -> claim -> Initiative/Action readable -> work completed; a separate fixture proves ambiguous evidence escalates without making human approval the normal path.
4. Repeating or concurrently triggering the lifecycle creates exactly one work row and one linked artifact.
5. Crash/timeout after artifact creation recovers by external key without duplication.
6. Stale lease acknowledgement is rejected and current-epoch acknowledgement succeeds.
7. Development defaults construct the service; fleet defaults return expected dark posture; misclassified dev dark is visible through posture/diagnostics and performs no automatic mutation pending the shared `SelfHealGate` foundation lane.
8. Backlog metrics distinguish healthy empty, collecting, ready, queued, and held readiness plus work claimed/retrying/dead-lettered/stalled state.
9. No raw feedback body, credential, transcript, prompt, or raw backend enum appears on logs/dashboard/queue surfaces.
10. Unit, integration, e2e, docs coverage, and class closure suites pass; this landing registers no feedback-drain self-action controller because automated recovery is explicitly deferred. <!-- tracked: slack-topic--1734007126 -->
11. Two real OS processes and a two-machine split-brain fixture still create one work/link pair; stale owner epochs cannot mutate.
12. Crash injection after every DB and downstream-artifact boundary recovers without duplicate Initiative/Action.
13. A realistic 150k-row source load with concurrent ingest respects per-stage/tick budgets and exposes cursor lag without starving oldest work.
14. Security fixtures cover token leakage, constant-time stale-token refusal, control/newline injection, CSRF/mutation-intent failure, and proxy replay.
15. `test:canonical-pipeline-runtime` constructed smoke/E2E negative fixtures fail for a dead/unconstructed consumer, disabled cadence, ineffective idempotency, missing progress metric, and fake wiring. These runtime failures are not assigned to the structural lint.
16. On the CI reference envelope (4 vCPU, 8 GiB RAM), the 150k-row fixture uses under 512 MiB RSS, processes at least 500 projected inputs per tick, completes a tick within 90 seconds, and claims the oldest eligible work within 10 ticks; regressions fail the performance lane.
17. Crash points before/after source append, projection transaction, sidecar advance, and compaction-manifest publish replay without loss or duplicate projection; concurrent append+compaction follows the checksummed generation handoff.
18. A collecting cluster with no new reports becomes due, is selected by the independent due index within its bounded fairness window, and makes overdue/lag metrics observable.
19. The normal readiness lifecycle completes with no PIN or human mutation: a registered frontier-model agent approves a bounded proposal set and the exact set advances once.
20. Authority fixtures reject unregistered, self-registered, revoked, stale-generation, stale-owner-epoch, wrong-model, and envelope-exceeding agents; only the PIN-bound operator surface can create, revoke, or restore registry generations, and registry/audit restore preserves those decisions.
21. Proposal-set drift, prompt/schema/model canary drift, injection suspicion, low confidence, and spend-brake exhaustion never produce `ready`; they remain collecting or escalate, and the authority demotes to proposal-only where specified.
22. The model cannot emit or cause `held`; schema fixtures reject that output, while deterministic corruption and the human break-glass path can hold with audited reasons. Agent-requested release remains held until the named deterministic source/projection/authority revalidation predicate passes.

## Glossary

- **accepted intake**: an input durably acknowledged by a canonical ingress.
- **readiness**: registered frontier-model Instar agent authority for one cluster epoch to create work, with optional human escalation; not product lifecycle status.
- **work row**: the fenced SQLite queue record keyed to one readiness epoch.
- **Action artifact**: the single user-visible `InitiativeTracker` task created for a work row.
- **operated host**: the sole machine-registry owner permitted to mutate the canonical drain DB.
- **positive-control**: a collected test that begins at real ingress and proves the named consumer advanced the terminal handoff.

## Standard article to register

**Canonical Pipeline Operational Completeness (Accepted Intake Must Drain).** Rule: a canonical accepted intake must have an authoritative admission decision, one durable owner/fenced lease, operated cadence, explicit terminal disposition, backlog-age/progress observability, and an end-to-end positive-control proving the real consumer advances the handoff. A pipeline that makes a human its default approver is operationally incomplete unless a constitution-level requirement demands that gate: the default judgment authority must be a registered autonomous Instar agent using an appropriate frontier model within deterministic floors, with human review reserved for ambiguity, integrity repair, or explicit intervention. In practice: register every canonical pipeline in the closed manifest; every edge names wiring, idempotency, failure semantics, metrics, authority posture, and collected E2E evidence. Earned from: the feedback factory accepted and clustered roughly 12k reports into roughly 149 clusters while producing zero owned work, and another development install was dark; individually present stages—and a proposed manual approval queue—were mistaken for an operating loop. Traces to goal: self-hosting learning that converts fleet signal into verified improvement without moving the bottleneck onto operator attention. Applied through: canonical manifest, marker/discovery lint, CI-collected positive controls, runtime stall metrics, and semantic review. This specializes Close the Loop, Self-Hosting, Maturation Path, Judgment Within Floors, and the Bug-Fix Evidence Bar; it does not replace them. The registry article and structural guard land together and require operator ratification through the spec approval.

## Open questions

*(none)*

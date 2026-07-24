---
title: "Worker Blocker-Lifecycle Beacon and Metrics"
slug: "throughput-metrics"
author: "echo"
status: draft
parent-principle: "Signal vs. Authority — raw blocker lifecycle measurements inform diagnosis but never select work, rank workers, notify, block, or act."
parent-principle-fit: "The existing explicit commitment transition remains the sole mutation authority. The new ledger is derived, raw, nullable, measure-only state; SQLite loss cannot alter commitment success, and no scalar or action consumer exists. The persistence prerequisite additionally enforces Verify State, Not Symbol by acknowledging the authoritative rename rather than treating an exception-swallowing call as proof."
approved: true # blanket pre-approval from operator directive for post-convergence build/merge
ships-staged: true
rollout-disposition: active
rollout-source-pr: 1535
rollout-flag-path: monitoring.blockerLifecycleLedger.enabled
rollout-criteria: "At least one acknowledged blocker lifecycle transition is durably represented while the ledger remains measure-only and non-authoritative."
rollout-evidence-type: endpoint
rollout-evidence-ref: /blocker-lifecycle/summary
rollout-metrics-json: '{"cadenceHours":6,"evidenceMaxAgeHours":12,"metrics":[{"id":"completed-lifecycle-transitions","source":"feature-summary","sourceRef":"blocker-lifecycle.completed-transitions","direction":"at-least","threshold":1,"minSamples":1}]}'
build-root: "fresh worktree from JKHeadley/main v1.3.890 (6f8bcc6a9); never .dev/instar"
lessons-engaged:
  - "Structure > Willpower; Signal vs Authority; Judgment Within Floors"
  - "No Silent Degradation; Anti-confabulation; Verify State Not Symbol"
  - "Maturation Path; An Instar Agent Is Always Multi-Machine"
  - "Know Your Principal; Migration Parity; Agent Awareness; Testing Integrity"
review-convergence: "2026-07-21T07:29:24.953Z"
review-iterations: 6
review-completed-at: "2026-07-21T07:29:24.953Z"
review-report: "docs/specs/reports/throughput-metrics-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Worker Blocker-Lifecycle Beacon and Metrics

## 0. Outcome and narrowed boundary

The existing worker-declared `POST /commitments/:id/transition` request is the beacon. The worker already names the exact commitment and desired structural state; v1 does not infer, select, or bind a commitment from a hook session, topic, prose, or stop-gate verdict.

When a guarded transition persists `blockedOn:'none' → <blocked>`, `CommitmentTracker` opens a blocker episode and emits a post-persist change event. When a later guarded transition returns it to `none`, or a true terminal path (`delivered|withdrawn|expired`) closes the commitment, the same tracker closes the authoritative episode once. A separate measure-only SQLite ledger materializes at-least-once events with idempotent dedupe into three raw factors:

1. `request-to-persist` — server time from accepting the worker's transition request to the persisted `none→blocked` state;
2. `clear-latency` — server time from the persisted episode start to its persisted close.
3. `deliverable-completion` — a count of persisted delivered commitment transitions, activated by the post-floor operator increment in §3.1.

No scalar/index, ranking, autonomous action, stop hook, focus registry, rich mentee probe, notice, or dashboard action ships. Parallelism utilization and rework/bounce rate remain `ACT-THROUGHPUT-POST-FLOOR`, owner `throughput-program`, trigger `their producer contracts stabilize`. Deliverable completion count is now the implemented §3.1 increment. <!-- tracked: topic-29723 --> A possible focus-binding convenience is separately named `ACT-COMMITMENT-FOCUS-BINDING`, owner `commitment-program`, trigger `verified repeated wrong-id/ambiguous-id transition incidents`; it is not needed by or included in v1. <!-- tracked: topic-29723 -->

Concrete example: the worker posts a guarded transition for `CMT-42` from `none` to `external`. The server timestamps request acceptance, validates and persists the exact named record, starts an episode, and records the request-to-persist duration. Ten minutes later the worker posts the exact record's transition to `none`; the episode closes and records ten-minute clear latency. No message or action is generated.

## 1. Existing authority and storage reused

- `CommitmentTracker.transitionState()` and `POST /commitments/:id/transition` remain the sole mutation authority. Existing owner routing, well-formedness validation, action-class requirement, topic transfer rules, optimistic versioning, atomic temp-file replacement, and replication remain authoritative.
- The new episode fields live on the commitment so block state and lifecycle state cannot split across stores.
- `FeatureMetricsLedger` supplies the SQLite/WAL, indexed-window, injected-clock, bounded pruning, close, and never-throw write pattern. A separate `BlockerLifecycleLedger` prevents schema/category contamination.
- The standard AgentServer bearer middleware already protecting `/commitments` also protects the two local read routes; no peer/export route ships in v1.

After routing reaches the authoritative origin, `prepareTransition()` performs existence, true-terminal, normalized-state, and no-op validation without mutation. Only after that succeeds does the origin sample its monotonic start immediately before `applyPreparedTransition()`. The factor ends at acknowledged rename; forwarding/network/auth/body/validation time is excluded, and the forwarding machine supplies no metric timestamp. Callers cannot provide or override metric timestamps. Invalid, forbidden, terminal, wrong-origin, or no-op transitions produce no episode and no metric row.

Alternatives considered: a Stop-hook beacon would need to infer which commitment a session meant, duplicating authority and introducing the wrong-record failure class. A focus registry would reduce ambiguity but still be a new selection subsystem and is excluded from v1. A second beacon endpoint would duplicate the existing guarded transition route. Prometheus/OpenTelemetry support local buffering, but add a collector/export/security lifecycle for two offline-first factors; the existing local ledger pattern is required here because reconciliation must join authoritative commitment episodes without network availability and peer diagnostics must reuse Instar's authenticated machine identity. Export is outside this raw two-factor contract.

### 1.1 Foundation repair: observable store commit

Current `saveStore()` catches file-write/rename failure and returns no result, so return from `mutateSync()` is not proof that persistence occurred. v1 first repairs that foundation for every CommitmentTracker write funnel: `saveStore()` returns `{state:'committed'}|{state:'deferred'}` <!-- tracked: throughput-metrics-batch-state --> `|{state:'failed',errorClass:'mkdir'|'temp-write'|'rename'}`, where committed means the authoritative `commitments.json` rename completed. Here the middle state is a completed batch-buffer state, not postponed work. Meta-sidecar failure remains separately degraded and cannot turn an already committed store replacement back into failure.

For synchronous non-batched mutation, the complete in-memory store snapshot is taken immediately before stamp/apply/save. For async CAS, caller code may await while producing its draft; only after the await and successful version CAS does the tracker take the complete snapshot, then stamp/apply/save with no await until rename or rollback. The snapshot includes every record, `lastModified`, versions, `replicationSeq`, `lastMutatedSeq`, and incarnation fields. Failure before rename restores byte-equivalent state and throws `CommitmentPersistenceError`. Routes translate it to 503. Existing best-effort background callers catch/log the typed error at their boundary; interactive mutation routes no longer report an unpersisted state as success.

Existing sweep batching becomes an explicit batch transaction: entering a batch takes one full-store snapshot; inner `mutateSync` calls receive `deferred` (the batch-buffer state defined above), return results only to the private sweep coordinator, and enqueue no externally visible post-commit event. <!-- tracked: throughput-metrics-batch-state --> The final flush performs one acknowledged rename. Success releases all queued events/results in mutation order; failure restores the pre-batch snapshot, discards every queued event/result, and makes the sweep return a typed batch failure. Nested batches are refused. Transition HTTP requests never join a sweep batch. Thus no public success or telemetry event precedes its authoritative rename.

This is atomic-persistence acknowledgement, not an fsync/crash-durability claim. Tests inject mkdir/temp-write/rename/meta failure and prove: no success response or post-commit event before rename; rollback before rename; committed success despite later meta failure; next boot matches the acknowledged store. `request-to-persist` ends only when this acknowledged rename returns.

This foundation repair is explicit build increment 0 inside the same PR and lands as an independently reviewable commit before ledger wiring, with no metric imports/config/behavior. It has its own release fragment and rollback criterion: any write-funnel regression reverts increment 0 before metric rollout; disabling the later metric does not undo a proven persistence fix. It touches every tracker write funnel, so its focused failure/concurrency/batch suite and full CommitmentTracker/PromiseBeacon regressions must be green before increment 1 may proceed; separating it into a later dependency would make the metric impossible to define honestly.

## 2. Atomic blocker episode lifecycle

The tracker adds bounded additive fields:

```ts
blockerEpisodes?: Array<{
  schemaVersion: 1;
  episodeId: string;              // UUID
  startedAtMs: number | null;     // wall time sampled for the committed none→blocked write
  requestEventExpected: boolean;  // true only for a v1 route-created measured episode
  originMachineId: string;
  initialClass: BlockedOn;
  transitions: Array<{ atMs: number; from: BlockedOn; to: BlockedOn }>;
  closedAtMs?: number;
  closeReason?: 'cleared'|'delivered'|'withdrawn'|'expired';
  clearSourceId?: string;         // blocker-lifecycle-v1:clear:<episodeId>
  clearTelemetryCompleteAtMs?: number;
  transitionOverflowCount: number;
}>
```

Inside the existing synchronous `mutateSync` funnel, one store replacement commits `blockedOn`, episode mutation, commitment version, and replication sequence together:

- `none → blocked`: create one episode using the commit wall clock; cap class transitions at 16, then preserve the first 8 + newest 8 and increment `transitionOverflowCount`.
- same blocked class: do not create/reset an episode or metric event, even if owner/actionClass/supersededBy changes; a fully normalized patch equal to current state returns the current record without version bump or event.
- `blockedA → blockedB`: preserve start/id, append one bounded class transition.
- `blocked → none`: stamp close fields once before persistence.
- true terminal paths `delivered|withdrawn|expired`: close an open authoritative episode once in the same terminal mutation. `verified|violated` are oscillating assessment states, not terminal; they never implicitly close or reset `blockedOn`.
- legacy blocked commitments without a start gain `startedAtMs:null`; clearing them records a missing/excluded outcome, never invented latency.

The history holds at most 64 episodes. Open and unconfirmed closed episodes are never age-pruned. Confirmed closed episodes prune at 30 days during housekeeping; at capacity they may prune oldest-first before 30 days. Guard health degrades at 48 open/unconfirmed entries (75% pressure), before loss. If 64 remain, the authoritative transition still proceeds, increments the request-factor daily drop bucket, and stores one current-record marker `blockerMeasurementDropped:{openedAtMs}` instead of a full episode. On clear/true-terminal, that marker increments the clear-factor daily drop bucket at close time and is removed; a later reopen creates a new marker. Thus request missing counts at open, clear missing counts only at close, and open/clear/reopen cannot double-count. Buckets retain 30 UTC days of counts only, no commitment id. Telemetry can never refuse the worker's state transition. A closed full episode cannot be overwritten by a later open before reconciliation.

Co-location is intentional: current open state, bounded closed handoff, and replication sequence must commit atomically with `blockedOn`. An append-only lifecycle sidecar would reintroduce a two-store commit/recovery protocol and could disagree with the commitment after crash. At 64 entries and 16 bounded class transitions, the worst-case additive record size is capped and the 48-entry pressure guard catches write amplification before drops; the soak's route-latency ratio catches whole-store cost.

The route captures `process.hrtime.bigint()` plus wall time after local owner routing and validation, immediately before invoking the mutation. On acknowledged rename it computes monotonic `request-to-persist` duration and emits the post-commit event. This factor is explicitly best-effort: a process crash after rename and before SQLite insert loses that one latency sample because the exact monotonic completion duration cannot be included in the file replacement it measures. Coverage counts this as missing; reconciliation does not fabricate it from wall clocks. SQLite writing occurs after authoritative persistence and never rolls it back. The event source ids are opaque and deterministic without commitment identity:

- `blocker-lifecycle-v1:request:<episodeId>`;
- `blocker-lifecycle-v1:clear:<episodeId>`.

Unique source ids make at-least-once post-persist delivery/reconciliation materialize one ledger row without adding a receipt/index transaction system to `commitments.json`. The already-opaque versioned source id is stored as-is, not hashed again. v1 event kinds are closed to `request|clear`. Class changes are episode audit history, not separate ledger events. A later event kind requires a schema/version review. Server process exclusivity remains the existing `SingleInstanceLock`; this feature does not claim new multi-process storage safety.

Only the commitment's origin store mutates it: the existing `resolveCommitmentRoute` forwards a request from any other machine to that origin, while `CommitmentsSync` replicas are advisory read copies keyed by `(originMachineId,id)` and never merged back into the origin. Therefore open/clear and request timing occur on one origin; topic transfer does not transfer commitment-store authority. Incarnation fencing replaces a rewound/restored replica wholesale and cannot resurrect origin state. Mixed-version peers preserve additive JSON fields when serving but report no local metric support; an old origin simply has no episode telemetry. Replica conflicts do not exist in this one-writer model; forged third-party origins remain rejected by `CommitmentsSync`.

Clear latency uses stored wall times because an episode may span restart. Negative duration or duration above 30 days becomes `clock-regression-or-implausible`, null, and excluded; it never enters percentiles/trends.

## 3. Closed raw factor set

### 3.1 Post-floor operator increment: deliverable completion count (2026-07-21)

The operator's Drive 8 directive activates the previously tracked post-floor deliverable-rate increment after observe-only throughput floor #1533. It extends this same ledger and these same read routes; it does not create a parallel metrics store. A third closed factor, `deliverable-completion`, is derived from the existing persisted `CommitmentTracker` `delivered` transition. Its source identity is an opaque SHA-256-derived `throughput-v1:completion:<id>` value, its value is a count (never latency), and reconciliation backfills already-delivered commitments idempotently after restart.

The summary adds `{factor:'deliverable-completion',unit:'count',completed,total,averagePerDay,...}`. The trend includes every complete UTC day (including zero-count days), excludes the current partial day from comparative direction, compares the first and second rolling halves, and reports `direction:'climbing'|'flat'|'declining'|'insufficient-data'` plus a ratio when defined. The route response schema advances to version 2 because the factor set was closed in version 1; mixed-version peers are honestly `unsupported`, never silently read as zero. This count composes with #1533 only as another observation. It grants no work-selection, pressure, notification, grading, blocking, or action authority.

### 3.2 Live completion loop closure (2026-07-21)

Real deliverables enter this metric only through the existing commitment lifecycle: create the commitment for the concrete deliverable, then use its persisted `deliver` transition when the deliverable is actually complete. A commit, pull request, chat message, session stop, or inferred activity is not a substitute. Drive 8's six completed pull requests were registered and delivered through that same public commitment path; no drive-specific producer or parallel store was added.

Startup and recovery reconciliation remains bounded to 64 commitments per event-loop turn, but an incomplete sweep schedules its next slice immediately. Only a complete sweep returns to the five-minute steady-state cadence. This preserves the bound and failure brakes while preventing recent delivered commitments near the tail of a mature store from remaining invisible for five minutes per slice.

The completion trend keeps `days`, half comparisons, `ratio`, and `direction` restricted to complete UTC days. It additionally returns `windowTotal`, `currentDayCount`, and `cumulativeDays`, whose final `complete:false` row is the current UTC day. Those additive fields make a real delivery visibly increment the live count immediately without allowing a partial day to distort the comparative direction. Pool validation recomputes cumulative arithmetic and consecutive dates before accepting a peer response. Every field remains descriptive only and grants no selection, pressure, notification, grading, blocking, or action authority.

`BlockerLifecycleLedger` accepts only `request-to-persist|clear-latency|deliverable-completion`. The first two are latency factors; `deliverable-completion` is the count factor defined in §3.1. Rows contain origin machine id, opaque versioned source id, observed server time, latency milliseconds or null, outcome, and schema version. They contain no prose, commitment/user text, topic id, repository, branch, raw fingerprint, or action class.

Stable summaries return one closed object per factor:

```ts
{ factor:'request-to-persist'|'clear-latency',
  recoverability:'best-effort'|'reconcilable', completed:number, missing:number,
  excluded:number, coverage:number, medianMs:number|null, p95Ms:number|null,
  outcomes:{ observed:number, 'legacy-missing-start':number,
    'clock-regression-or-implausible':number, 'request-row-missing':number,
    'episode-dropped-capacity':number } }
```

Only `observed` rows have non-null latency and enter percentiles. Coverage is `completed/(completed+missing+excluded)`, null when the denominator is zero. Trends first discard the current incomplete UTC day and days with fewer than 3 completed samples, sort remaining daily medians oldest-to-newest, and require at least six. With `n` usable days, the first half is indices `0..<floor(n/2)` and the second is the remainder (the odd extra day goes second); each half must contain at least 9 completed samples across at least 2 days. The reported dimensionless ratio is `secondHalfMeanMs / firstHalfMeanMs` and lower is better. A missing or zero denominator returns ratio `null` with reason `insufficient-days|insufficient-samples|zero-denominator`; excluded/null days never occupy a half. The response includes `{day,medianMs,samples}` and each half's sample/day counts. This deliberately simple rolling-half delta is descriptive-only; it avoids implying Mann-Kendall/Theil-Sen significance on a seven-day dark-soak sample. There is no confidence claim, combined estimate, acceleration label, productivity label, worker grouping, normalization, or SLO.

Closed classification table:

| Factor | Outcome | Source | Window timestamp | Class |
|---|---|---|---|---|
| request-to-persist | `observed` | SQLite row | row `observedAt` | completed |
| request-to-persist | `request-row-missing` | v1 episode with `requestEventExpected:true`, non-null start, and no request row after full sweep | episode `startedAtMs` | missing |
| request-to-persist | `episode-dropped-capacity` | request-factor store drop bucket incremented at dropped open | opening bucket UTC day | missing |
| request-to-persist | legacy/clock outcomes | structurally impossible | — | always zero |
| clear-latency | `observed` | SQLite row | row `observedAt`/episode close | completed |
| clear-latency | `legacy-missing-start` | closed episode | `closedAtMs` | excluded |
| clear-latency | `clock-regression-or-implausible` | closed episode | `closedAtMs` | excluded |
| clear-latency | `episode-dropped-capacity` | clear-factor store drop bucket incremented when dropped marker clears | closing bucket UTC day | missing |
| clear-latency | request-row-missing | structurally impossible | — | always zero |

For both factors `completed === outcomes.observed`; `missing` and `excluded` are the sums of exactly the table rows marked with that class. The `sinceHours` lower bound applies to the named window timestamp; a daily drop bucket overlapping the boundary is included only when its UTC start is within the window (documented day-granularity bound).

Empty example: `{factor:'request-to-persist',recoverability:'best-effort',completed:0,missing:0,excluded:0,coverage:null,medianMs:null,p95Ms:null,outcomes:{observed:0,'legacy-missing-start':0,'clock-regression-or-implausible':0,'request-row-missing':0,'episode-dropped-capacity':0}}`. `clear-latency` always reports `recoverability:'reconcilable'`. Sparse trend example: `{factor:'clear-latency',days:[],firstHalf:{days:0,samples:0,meanMs:null},secondHalf:{days:0,samples:0,meanMs:null},ratio:null,reason:'insufficient-days'}`. All counters are non-negative safe integers; nullable numeric fields are exactly those shown.

Missing/unobserved timestamps remain null and never become zero. The founding 75-minute stall is context only, not a threshold in v1. “Throughput index” is reserved for the post-floor convergence after all five factors have real producers.

## 4. Ledger durability and reads

The ledger uses SQLite WAL, `synchronous=NORMAL`, `busy_timeout=25ms`, unique `(origin,factor,sourceEventId)`, injected clock, 90-day/250,000-row caps, 1,000-row prune batches, clean close, and caught/never-thrown writes. Post-commit events enter a bounded 256-item in-memory queue drained outside the transition response; overflow increments failure/missing counters (clear remains reconcilable, request does not). A 50ms insert is an observed degradation threshold, not an interrupt claim. If unavailable, metric routes return 503 while commitment transitions continue normally.

Reconciliation covers clear rows only; request-to-persist is honestly best-effort. It scans origin commitments in stable id order, at most 64 per pass, with a durable local cursor that wraps after every complete sweep. It starts after 5s, doubles failure backoff through `5s|10s|20s|40s|80s|5m`, and opens a 15-minute breaker after 6 consecutive SQLite failures. One 25ms recovery probe closes the breaker; success resets cadence to five minutes. Audit/log emission is deduped by `blocker-ledger-reconcile:<errorClass>:<UTC-hour>` with at most one row/hour/class and no notice. Startup/restart resets in-memory backoff/cache but reloads the cursor; repeated full sweeps and unique keys are safe. Reconciliation never changes commitment authority; after inserting a clear row it best-effort stamps `clearTelemetryCompleteAtMs`, and stamp failure only causes a deduped retry. That marker is monotonic: code may add it once and never clear it; origin sequence replication replaces stale replicas with the later marked record, while mixed-version peers preserve the unknown additive field.

The ledger/guard exposes metadata-only counters: `attempted`, `inserted`, `deduped`, `failed`, `reconciled`, `requestSamplesMissing` (persisted episode ids with no request row, counted during full sweeps but never fabricated), `episodeDroppedCapacity`, breaker state, last success/error class, and p95 insert/reconcile duration. Error responses and diagnostics allowlist enums/counters only—never commitment ids, fingerprints, SQLite paths, or transport errors.

Routes:

- `GET /blocker-lifecycle/summary?sinceHours=1..168&scope=local|pool` → `{schemaVersion:2,scope:'local'|'pool',origins:[{machineId,factors,counters}],poolComplete,failures,generatedAt}`. The deliverable-completion factor labels this independently selected rolling scope as `window:{kind:'rolling-hours',hours:sinceHours}` (default 24 hours).
- `GET /blocker-lifecycle/trend?windowDays=7..90&scope=local|pool` → `{schemaVersion:2,scope:'local'|'pool',origins:[{machineId,factors:[{factor,days,firstHalf,secondHalf,ratio,reason}]}],poolComplete,failures,generatedAt}`. Its completion factor labels the independently selected scope as `window:{kind:'rolling-days',days:windowDays,dailyBuckets:'utc',currentDay:'partial'}` (default 7 days); `windowTotal` includes the partial current UTC day while half comparisons use the preceding complete UTC-day buckets.

Both use the standard AgentServer bearer middleware and its scrubbed `{error:<bounded-enum>}` envelope; bad windows/scope are 400, auth failure 401, disabled/unavailable local ledger is 503, success is 200. Unknown response fields are additive; clients must key on `schemaVersion:2`. Schema-v1 peers are unsupported, never zero. `scope=pool` reuses the existing `/judgment-provenance?scope=pool` transport exactly: `resolvePeerUrls`, `isPeerUrlAllowedForCredentials` before attaching the configured agent bearer, local-only recursive fetch, 5s timeout, and peer identity rebound to configured `machineId` rather than trusted from payload. It fetches aggregation-only local summaries/trends—never rows—with ≤16 peers, concurrency 4, 512KiB/peer and 4MiB total response caps, 750ms peer/2.5s total deadline, and 60s coalescing cache. Every field is type/range allowlisted, including consecutive UTC day labels and recomputed count arithmetic. Any peer failure yields `{machineId,reason:'unreachable'|'unsupported'|'http-error'|'invalid-body'|'truncated'|'deadline'|'omitted-cap'}` and `poolComplete:false`; no cross-origin aggregate is computed. Old servers are `unsupported`, never zero. Generated CLI/awareness consumers must render `poolComplete` and failures before origin values and must show each origin's coverage/sample counts. Thus the unified surface lists every origin's component truth without laundering partial data into a fleet statistic.

### 4.1 Assumed existing mechanisms

- **development-agent gate:** config omission resolves live only on the designated development agent and dark on fleet.
- **guard health:** existing metadata-only `GET /guards` operational status, not a user notice or action authority.
- **topic transfer/origin routing:** conversations may move machines, while commitment mutations still forward to the record's origin owner.
- **incarnation fencing:** restored commitment origins mint/change a store incarnation so replicas discard stale snapshots and pull again from zero.
- **throughput floor:** the separately merged observe-only system (#1533) that this completion-count signal composes with without gaining authority.

## 5. Rollout, migration, awareness, rollback

- `monitoring.blockerLifecycleLedger.enabled` is omitted by default and resolved through the development-agent gate: live on development agents, dark on fleet. `dryRun` is compatibility-only; all modes remain measure-only.
- `DEV_GATED_FEATURES`, defaults/types, and `PostUpdateMigrator.migrateConfigBlockerLifecycleLedgerDark()` preserve explicit configuration.
- Commitment store version advances additively; load clamps episode enums/counts/bounds, preserves unknown fields, converts a legacy single episode if encountered, and old peers safely ignore the additive array. No destructive rewrite runs merely to enable metrics.
- `guardStatus()` is `loadBearing:false`; disabled/unavailable routes return 503.
- `generateClaudeMd()`/`migrateClaudeMd()` explain that existing worker-declared commitment transitions produce blocker-lifecycle measurements. They never instruct action based on a metric.
- Rollback is `enabled:false` plus code revert; additive episode fields and SQLite rows remain inert. No destructive migration or repair.
- Dark rollout exits only after a seven-day soak with zero lost-update/crash-recovery failures, zero refused transition caused by telemetry, ≥95% request-row coverage, 100% eligible clear-row materialization after reconciliation, p95 ledger insert ≤25ms, p95 reconciliation pass ≤100ms, and transition-route p95 ≤1.20× the seven-day pre-enable baseline with an absolute ≤250ms ceiling. No new notifier is added; existing guard health is the visibility surface.

## 6. Acceptance criteria

### Merge-blocking

1. The existing guarded transition for an explicitly named commitment is the only beacon; no session/hook/focus selection code exists.
2. Server monotonic acceptance/acknowledged-rename timestamps yield best-effort `request-to-persist`; callers cannot supply either and lost post-rename delivery appears as missing coverage, never reconstructed.
3. Invalid, forbidden, true-terminal, wrong-origin, no-op, or malformed transitions create no episode/metric; no claim is made about a nonexistent caller-supplied topic assertion.
4. `none→blocked`, class changes, clears, and all terminal paths preserve the single-close episode state machine in the authoritative commitment write; derived telemetry is at-least-once with idempotent row materialization.
5. Sync/async tracker interleavings and restart lose no commitment/episode update; pre-rename failure rolls memory back and returns typed failure, while SQLite failure never changes an acknowledged transition.
6. Legacy, clock-regressed, and implausible episodes emit honest null/excluded outcomes.
7. Factor enum accepts exactly `request-to-persist|clear-latency` and rejects a third.
8. Summary/trend are raw component-only and handle sparse/odd/current-day/missing/excluded cases without a scalar or exponential claim.
9. Reconciliation may retry clear rows after interruption/restart but materializes one row per unique factor source id; permanent failure obeys backoff/breaker/deduped-audit brakes.
10. Reopen-before-reconcile preserves the prior closed episode; 64-row capacity prunes only confirmed history or drops measurement with degraded health without blocking state.
11. Rate/DB/row/history limits fail telemetry safely or return explicit degraded state without blocking a valid commitment transition.
12. Dark gate, migration, guard/counter status, awareness generation/migration, prune/close/SQLite failure, route schema/status, and old-server/new-client compatibility pass.
13. Existing CommitmentTracker, PromiseBeacon, decision-quality, benchmark-divergence, build, unit, integration, and e2e suites pass.
14. No focus binding, stop hook, inferred commitment, new autonomous action, floor producer, rich probe, notice, dashboard action, governor admission, or latch transition exists in the diff.
15. Parallelism utilization, rework/bounce rate, focus binding, and any later combined index remain tracked follow-ons; deliverable completion count is implemented by §3.1.
16. Persistence tests inject mkdir/temp-write/rename/meta failure; replication tests cover origin routing, incarnation rewind, stale replica, mixed-version peer, and non-resurrection.
17. Pool tests cover credential allowlisting/non-forwarding, configured-origin rebinding, response field clamps, concurrency/byte/deadline/cache caps, old peers, and null-on-incomplete behavior.

### Dark-soak evidence

- Record p25/p50/p75/p95, coverage, exclusions, ledger/reconciliation completion, and route/write latency for at least seven days.
- Existing `GET /guards` exposes architecture/availability degradation; v1 never self-migrates or notifies.

## Terminology

- **beacon:** in v1, the worker's existing explicit guarded commitment transition—not a new hook or inferred signal.
- **request-to-persist:** server-measured time from accepting a valid transition request for processing to the authoritative store replacement completing.
- **clear-latency:** same-origin server time an opened blocker episode remained active.
- **episode:** authoritative lifecycle metadata colocated with one commitment's blocked state.
- **ledger:** non-authoritative SQLite telemetry derived from persisted commitment transitions.
- **acknowledged rename:** observable completion of the authoritative JSON atomic rename; not a claim that directory/file fsync completed.
- **true terminal:** a permanently closed commitment status (`delivered|withdrawn|expired`), unlike oscillating `verified|violated` assessments.
- **development-agent gate:** the existing config rule that enables omitted experimental flags only on the designated development agent and leaves fleet installs dark.

## Multi-machine posture

Authoritative episode state is unified through existing origin-owned commitment routing and `CommitmentsSync` read replication; replicas never write back or conflict-merge. Metric rows, reconciliation cursor, SQLite availability, retry breaker, and cache remain origin-local implementation state, while the user-facing summary/trend is unified by the bounded authenticated `scope=pool` proxied read. On restart the cursor reloads, breaker/cache reset conservatively, and a bounded full sweep resumes. Topic transfer leaves commitment mutation at its origin through `resolveCommitmentRoute`. Missing origins produce explicit incomplete results rather than a partial fleet statistic.

## Decision points touched

- Explicit transition eligibility — `invariant`: existing owner routing and closed state validation remain the authority.
- Episode transition/close — `invariant`: deterministic persisted before/after state machine.
- Per-factor summary/trend — `invariant`: raw arithmetic with explicit missing/excluded data and no action authority.
- Persistence acknowledgement — `invariant`: authoritative rename success or typed rollback/failure.
- Reconciliation retry/breaker — `invariant`: closed cadence/backoff/breaker table with no notice.
- Replication resolution — `invariant`: one origin writer; authenticated replica replacement/read only.
- Route authorization/version/status — `invariant`: standard bearer middleware plus pinned v2 schemas/statuses.
- Pool completeness/peer classification — `invariant`: closed allowlists, caps, failure enums, and no cross-origin statistic.
- Rollout promotion — `invariant`: all numeric seven-day evidence gates must hold; otherwise remain dark.

## Frontloaded Decisions

- v2 is the existing explicit transition beacon plus two latency factors and one delivered-completion count factor.
- No focus binding, inference, scalar/index, or autonomous behavior ships.
- Parallelism utilization, rework/bounce rate, and any combined index remain tracked post-floor increments; bounded per-origin pool reads ship only to make the raw surface unified.
- Persistence acknowledgement, best-effort request coverage, bounded history, clocks, auth/schema/status, retry brakes, replication, numeric rollout, and rollback are pinned above.

## Open questions

*(none)*

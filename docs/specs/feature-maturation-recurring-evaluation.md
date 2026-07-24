---
title: "Feature Maturation D7 — recurring measurable evaluation on the shared metrics substrate"
slug: "feature-maturation-recurring-evaluation"
author: "instar-codey"
parent-principle: "Maturation Path — Test Agent → Development Agent → Fleet"
approved: true
approved-at: "2026-07-21T18:48:12Z"
approval-context: "Operator directive in Slack channel C0BA4F4E0FP: D7 current increment; per-feature measurable metrics and recurring re-score; extend, never duplicate"
ships-staged: true
rollout-flag-path: "monitoring.blockerLifecycleLedger"
rollout-criteria: "seven-day development-agent soak; every eligible rollout evaluated when due under its declared cadence; zero missed-due rows; no authority or blocker-state mutation"
rollout-evidence-type: "endpoint"
rollout-evidence-ref: "/blocker-lifecycle/summary"
review-convergence: "2026-07-21T19:06:06.356Z"
review-iterations: 6
review-completed-at: "2026-07-21T19:06:06.356Z"
review-report: "docs/specs/reports/feature-maturation-recurring-evaluation-convergence.md"
cross-model-review: "codex-cli:gpt-5.5; gemini-cli:gemini-3.1-pro-preview"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Feature Maturation D7 — recurring measurable evaluation

## Problem statement

PR #1540 makes maturation plans structurally visible and strengthens the existing Maturation Path. It does not make each dark or soaking feature measurable, and it does not periodically re-evaluate those features. A rollout can therefore still remain at a rung with an old evidence snapshot and no fresh score.

The operator requires the current D7 increment to make metrics trackable per feature and to re-score every dark/soaking feature on a recurring cadence. The implementation must reuse the existing rollout owner (`FeatureRolloutReconciler` + `InitiativeTracker`), the #1535 blocker-lifecycle SQLite/summary/trend substrate, and existing benchmark/decision-quality evidence. It must not create a second maturation registry, scheduler, feature-metrics database, or promotion authority.

## Foundation and duplicate audit

The implementation base is PR #1540 (`codey/feature-maturation-discipline`) until that dependency merges, then rebased onto fresh `main`.

Existing owners and the exact extension:

| Concern | Existing owner | D7 extension |
|---|---|---|
| Feature identity, stage, criteria | `FeatureRolloutReconciler` → `InitiativeTracker.rollout` | Add a bounded typed measurement contract to `RolloutInfo`; no second feature registry. |
| Durable measurements | `BlockerLifecycleLedger` SQLite | Add a `maturation_evaluations` table and methods on the same class/DB. The existing blocker table retains exactly its two factors. |
| Summary/trend reads | `BlockerLifecycleService.localSummary/localTrend` and `/blocker-lifecycle/*` | Add bounded `maturation` fields to those existing envelopes; no new dashboard/read engine. |
| Recurrence | Existing `BlockerLifecycleService` bounded timer pattern | One six-hour maturation timer owned by that service; no scheduled-job definition or second trigger path. |
| Model/benchmark evidence | Decision-quality and benchmark-divergence outputs | Metric contracts name these sources. D7 stores only scrubbed numeric observations and source refs; it never reruns an LLM or creates a benchmark harness. |
| Promotion | Human changes config/default; reconciler only observes | Scores are advisory signals. They never mutate flags, stages, initiatives, or approval state. |

Audit finding: extending the blocker table's `factor` enum would violate #1535's deliberate exactly-two-factor contract. D7 therefore adds a sibling table inside the same ledger owner rather than a third blocker factor. This is one measurement substrate, not a parallel engine: one SQLite handle, lifecycle, guard, retention pass, summary/trend surface, pool projection, and server wiring.

Standing duplicate guard: a unit/source ratchet asserts that `maturation_evaluations` is created only by `BlockerLifecycleLedger`, no `*Maturation*Ledger`/database class is introduced, and the blocker factor union remains exactly `request-to-persist | clear-latency`.

Mental model: D7 is a local append-only metric-observation table plus immutable deterministic evaluation snapshots, exposed through the existing blocker-lifecycle read surface. Sharing the ledger owner is the integration constraint; observations/contracts/evaluations remain explicit domain objects.

## Design

### 1. Typed per-feature measurement contract

`RolloutInfo` gains optional `maturationEvaluation`:

```ts
interface MaturationEvaluationContract {
  cadenceHours: number;       // integer 6..168, multiple of 6
  evidenceMaxAgeHours: number;// integer cadenceHours..min(168, cadenceHours*2)
  metrics: Array<{
    id: string;               // /^[a-z0-9][a-z0-9-]{0,62}$/
    source: 'blocker-summary' | 'blocker-trend';
    sourceRef: string;        // bounded opaque stable row/field/task id, not a URL or prose
    direction: 'at-least' | 'at-most';
    threshold: number;
    minSamples: number;       // integer 1..100000
  }>;                         // 1..16, unique id
}
```

The spec scanner accepts a single frontmatter field `rollout-metrics-json`, parsed with `JSON.parse` and closed validation. Malformed/oversized input is omitted and therefore scores `missing-contract`; it never aborts reconciliation. A bounded validation result (`featureId`, error enum only: `invalid-json|oversized|invalid-shape|unknown-source-ref`) is counted by guard/summary diagnostics so the omission is not silent. The canonical scanner and local scanner use one exported parser. Reconciler updates preserve the contract across stage transitions.

Source references are not author-invented strings. D7 exports one closed, schema-versioned descriptor registry per producer. Every descriptor pins `source`, `sourceRef`, numeric unit, aggregation meaning, sample definition, freshness owner, `freshnessModel: wall-clock|activity-clock|window-derived`, the zero-activity result (`insufficient-evidence|valid-zero`), and whether later descriptor revisions are backward-compatible. V1's canonical pairs are:

| source | sourceRef |
|---|---|
| `blocker-summary` | `request-to-persist.coverage` |
| `blocker-summary` | `request-to-persist.p95Ms` |
| `blocker-summary` | `clear-latency.coverage` |
| `blocker-summary` | `clear-latency.p95Ms` |
| `blocker-trend` | `request-to-persist.ratio` |
| `blocker-trend` | `clear-latency.ratio` |

Decision-quality and benchmark are reserved follow-on producer families, not accepted V1 source enum values; they enter only in the PR that exports their stable descriptors. Adding or incompatibly revising a ref is a code-reviewed registry version change with a producer test; old observations retain their descriptor version.

Every feature at `dark`, `dry-run`, or `live` is evaluation-eligible. `default-on` is terminal for recurring evaluation but remains visible in retained trend history. This preserves the current four observed rollout stages; D7 does not rename runtime stages ahead of the later test-agent/dev-agent/fleet rollout implementation.

| Term | Values | Meaning in D7 |
|---|---|---|
| Observed runtime rollout stage | `dark|dry-run|live|default-on` | Derived by `featureRollout.ts` from the feature flag/default. |
| Initiative phase ids | `dry-run|live|default-on` | Existing tracker phases; `dark` is the implicit pre-phase. |
| Evaluation eligibility | `dark|dry-run|live` | Non-terminal stages re-scored; `default-on` retains history only. |
| D7's own rollout flag | `monitoring.blockerLifecycleLedger` | Whether this measurement substrate runs on the current agent; unrelated to a measured feature's stage. |

In evaluation rows, `rung` means the observed runtime rollout stage at evaluation time; it is not an Initiative phase id.

### 2. Numeric observation seam

The ledger accepts bounded `MaturationMetricObservation` rows supplied by existing measurement producers:

```ts
{ featureId, metricId, source, sourceRef, observedAtMs,
  value: number, samples: number, benchmarkRef?: string }
```

`benchmarkRef` is a bounded opaque identifier from the existing benchmark or decision-quality machinery, not raw prompt/evidence. Duplicate producer delivery is idempotent by `(origin, featureId, metricId, source, sourceRef, observedAtMs)`. D7 adds no model call and no raw evidence store.

Observations are origin-local. `observedAtMs` must be finite, non-negative, no older than 90 days, and no more than five minutes ahead of the accepting service clock; invalid/future rows are rejected and counted. The scorer selects only observations whose `origin` equals its own machine id. Pool projection never lets one origin satisfy another origin's contract.

The initial concrete adapter is the already-live blocker summary/trend service and accepts only the canonical pairs above. The same `observeMaturationMetric()` seam is exported for later decision-quality and benchmark-divergence descriptor integrations. D7 does not claim those producers are integrated, scrape its own HTTP routes, or parse human prose.

An eligible feature whose contract cites a producer that has not emitted receives an honest `insufficient-evidence` evaluation. Missing data is never coerced to zero and never treated as a pass.

### 3. Deterministic recurring scorer

`BlockerLifecycleService.evaluateMaturation(initiatives)` scans a stable, bounded list of at most 512 rollout initiatives. For every eligible feature, each pass writes one idempotent evaluation keyed by `(origin, featureId, dueSlotMs)`, where `dueSlotMs = floor(now / cadenceMs) * cadenceMs`; the observed `rung` is immutable row data, not key material. Re-running the same slot updates nothing and returns `deduped`, so a same-slot stage transition is reflected at the next slot. A contract change takes effect at the next due slot; the current slot remains bound to the first durably evaluated contract.

Each `(origin,featureId,contractHash)` has an `effectiveFromMs`: the latest of D7 enable time, first eligible observation, and first sight of that contract hash. Missed slots are never generated before this epoch. After later downtime, the scorer materializes up to four intervening due slots as explicit `missed-cadence` evaluations before scoring the current slot. It never fabricates metric values or backfills a pass. If more than four slots elapsed, one oldest bounded marker carries `additionalMissedSlots` (clamped to 10,000) and the other three most recent missed slots remain explicit. Thus recurrence failure stays durable without an unbounded catch-up loop.

The six-hour existing driver is the minimum clock. Consequently `cadenceHours` is a multiple of six in `6..168`; a contract cannot promise a cadence the driver cannot meet. Due slots are UTC epoch-aligned independently on each origin. Small clock skew changes only which origin-local slot is current near a boundary; no pool dedupe or pool-level missed-due calculation exists. NTP is not a correctness dependency.

For each metric:

- no valid contract: `missing-contract`;
- no observation meeting `minSamples`: `insufficient-evidence`;
- newest observation older than `evidenceMaxAgeHours`: `stale-evidence`;
- numeric comparison fails: `hold`;
- every metric is fresh, sampled, and passes: `ready`.

Closed precedence for a current evaluation is `missing-contract > insufficient-evidence > stale-evidence > hold > ready`; `missed-cadence` is reserved for an elapsed slot the process did not evaluate. The evaluation stores only feature id, observed rung, due slot, status, passing/total metric counts, minimum normalized margin, contract hash, newest evidence timestamp, and bounded source/benchmark refs. No titles, paths, criteria prose, logs, topics, prompts, or user data enter SQLite.

The `contractHash` is SHA-256 over canonical sorted contract JSON. Historical rows permanently retain the hash and cadence slot used when evaluated; they are never re-slotted or reinterpreted after a contract change. A changed contract begins at the next slot and trends expose the hash boundary.

Normalized margin is direction-aware and dimensionless: for `at-least`, `(value-threshold)/max(abs(threshold),1)`; for `at-most`, `(threshold-value)/max(abs(threshold),1)`, clamped to `[-1,1]`. It is descriptive only. The score never authorizes promotion.

`BlockerLifecycleService` is the single canonical driver: it performs one boot-delayed pass and one six-hour recurring pass over the injected `InitiativeTracker`. `evaluateMaturation()` is the called method and a direct test seam, not a second timer or public runtime trigger. Only this service timer owns missed-cadence materialization. The existing feature reconciler continues to refresh the same tracker independently; D7 reads its latest records and adds no callback trigger. There is no new cron/job file, autonomous session, attention item, or user message.

### 4. Existing summary and trend surfaces

`localSummary(sinceHours)` adds:

```ts
maturation: {
  eligible: number;
  evaluated: number;
  missedDue: number;
  byStatus: { ready, hold, 'stale-evidence', 'insufficient-evidence', 'missing-contract', 'missed-cadence' };
  features: Array<{ featureId, rung, status, evaluatedAt, nextDueAt,
    passingMetrics, totalMetrics, minNormalizedMargin, newestEvidenceAt, benchmarkRefs }>;
}
```

The feature list is stable-sorted and capped at 512. `missedDue` counts eligible features with no durable evaluation in their current cadence slot. A failed write therefore remains visibly missed; it is never inferred as healthy.

`localTrend(windowDays)` adds per-feature daily latest evaluations, capped to 512 features × 90 days. It reports status and `minNormalizedMargin` only; no cross-feature scalar, average, fleet ranking, or productivity claim. Pool reads preserve machine-tagged origins and existing completeness/failure rules. Sanitizers explicitly allowlist the new shape and reject/clamp malformed peers; old peers omit `maturation` and are reported as `unsupported-maturation`, never as zero.

### 5. Retention, failure, and authority

- Same SQLite handle/WAL/busy timeout/close/registry as blocker lifecycle.
- Evaluations retained 90 days, pruned in the ledger's existing bounded `prune()` pass; max 250,000 maturation rows with 1,000-row prune batches.
- Observation lookup has a covering index on `(origin,feature_id,metric_id,source,source_ref,observed_at_ms DESC)`; current-slot lookup has a unique index on `(origin,feature_id,due_slot_ms)`; trend has `(origin,feature_id,due_slot_ms DESC)`. One batched window query prefetches the latest candidate observations for the pass and indexes them in memory by the bounded composite key; scoring performs no per-metric SQL query and one indexed slot insert per feature, bounded at 512 × 16 inputs.
- Observation/evaluation writes are fail-soft. Ledger failure degrades guard health and read coverage but never blocks a rollout transition or feature behavior.
- Contract parse failure, source absence, clock regression, NaN/Infinity, oversize ids/refs, and sample overflow become bounded rejection counters or non-ready statuses.
- Recurring scoring never writes `InitiativeTracker`, config, standards, approval, or feature flags. It is a signal. Human/config remains authority.
- No attention notification ships in D7. D4 remains the later stuck-dark surfacing arm; D7 is the measurement/recurring driving arm visible on pull.

### Alternatives considered

OpenTelemetry/Prometheus would provide general time-series transport but would add an external availability/configuration dependency and a second per-feature metrics owner on disconnected personal agents. A generic workflow scheduler would duplicate the already-running reconciliation/service cadence and still need this storage/read contract. A new `MaturationLedger` would split lifecycle, retention, pool projection, and guard health. The selected additive table is intentionally a small embedded time-series pattern: SQLite plus bounded descriptors gives offline durability and one pull surface while preserving #1535's blocker-factor semantics. It follows established event/time-series invariants: observations and evaluations are append-only, records are immutable after dedupe, timestamps and cardinality are bounded, and metric descriptors/rows are explicitly schema-versioned.

## Multi-machine posture

Initiative rollout identity and stage remain unified by the existing canonical-spec scan and origin feature records. Numeric observations/evaluations are machine-local measurements because model routing, logs, and feature behavior can differ per physical runtime. The existing authenticated `/blocker-lifecycle/*?scope=pool` proxied-on-read surface returns machine-tagged origins with completeness failures; it never merges distinct origins into one fleet score.

machine-local-justification: operator-ratified-exception (`docs/specs/throughput-metrics.md` and PR #1535 establish per-origin metric truth with pool projection; D7 extends that exact registry key and storage owner).

No credentials, hardware identities, or user-visible URLs are introduced.

## Decision points touched

- Contract validation — `invariant`: closed types, numeric/id/range bounds, and omission-on-invalid; no competing signals.
- Evaluation eligibility — `invariant`: current rollout stage is one of `dark|dry-run|live`.
- Per-metric pass — `invariant`: fixed direction/threshold/sample/freshness comparison declared by the feature.
- Status precedence — `invariant`: the closed conservative order above; missing/conflicting evidence cannot pass.
- Recurrence slot/dedupe — `invariant`: deterministic cadence slot and unique key.
- Promotion — `invariant`: D7 has no mutation path; existing human/config change remains sole authority.
- Pool completeness — `invariant`: existing machine-tagged projection and explicit failure semantics.

- Model authority — `invariant`: no LLM judgment point is introduced; later benchmark and decision-quality producers may supply numeric observations, but their existing arbiters remain unchanged.

## Frontloaded Decisions

- D7 extends `BlockerLifecycleLedger` with a sibling table; it does not alter the exactly-two blocker factor enum.
- The four current runtime rollout stages remain intact. The approved three-rung test-agent/dev-agent/fleet semantics land in the separately scoped runtime ladder work.
- Contracts carry 1..16 metrics with fixed threshold/direction/sample/freshness fields; arbitrary formulas and prose parsing are rejected.
- A single six-hour service cadence follows the existing bounded timer pattern. Per-feature `cadenceHours` controls due slots, not scheduler proliferation.
- Missing, stale, or conflicting evidence is non-ready and visible; there is no implicit pass.
- All scores remain advisory and pull-only in D7. D4 owns later stuck-dark attention surfacing.
- Local truth remains machine-tagged and pool-projected; no cross-machine aggregate score exists.
- D7 is a Tier-2 runtime extension with full migration/side-effects/review ceremony.

## Maturation plan

- **test-agent-live:** Run the scorer and blocker adapter live on Codey with fixtures for ready, hold, missing, stale, duplicate-slot, malformed peer, and ledger failure.
- **dev-agent-live:** After the test-agent soak passes, enable on Echo through the same existing development-agent gate and verify every active rollout has a fresh evaluation each cadence.
- **fleet:** A separately reviewed default flip only after the seven-day evidence gate passes; D7 never performs the flip.
- **graduation criterion:** Seven consecutive days with every eligible rollout evaluated each cadence, zero false-ready results, zero missed-due rows after one recovery cadence, no blocked rollout/config operation, pool omission honesty intact, and p95 added evaluation pass under 100ms for 512 features × 16 metrics.
- **dark-window:** Review the test-agent evidence within 14 days of merge; remain dark outside development agents until disposition.

## Acceptance criteria

1. Local and canonical scanners parse one closed metric contract identically; malformed/oversized contracts omit safely.
2. Reconciler create/update/stage-transition paths preserve the contract and never create a second initiative.
3. The blocker factor type/table still accepts exactly two original factors.
4. One ledger/database owner persists idempotent bounded observations and cadence-slot evaluations.
5. Every eligible rollout attempts one idempotent evaluation per due slot, including features with missing contracts/evidence; durable absence is counted by `missedDue`.
6. Stale/missing/NaN/undersampled data never produces `ready`; precedence and score math are deterministic.
7. Summary/trend expose per-feature results with caps and honest pool compatibility; no combined scalar exists.
8. Retention, pruning, close, unavailable SQLite, queue pressure, and restart/dedupe paths are tested.
9. No code mutates a feature flag, rollout stage, initiative, approval, or notification from an evaluation.
10. Source ratchet proves no parallel maturation ledger/database/job/read engine was added.
11. Existing blocker-lifecycle, InitiativeTracker, FeatureRolloutReconciler, decision-quality, benchmark-divergence, type, lint, unit, integration, and e2e tests pass.
12. Upgrade/migration awareness describes D7 as measure-only and recurring; no operator action is implied.
13. V1 proves the blocker summary/trend adapter end to end. Decision-quality and benchmark are reserved follow-on producer families and are not valid V1 source enum values; the generic observation seam alone does not pretend that integration is live.
14. Query-plan tests assert all newest-observation, current-slot, and trend reads use the declared indexes and preserve the 512 × 16 bound.

## Rollback

Disable the existing blocker-lifecycle development gate or revert the code. The sibling table becomes inert; no authoritative state, feature configuration, rollout stage, or external system requires rollback. A later version may prune the inert rows through the same bounded ledger retention path.

## Open questions

*(none)*

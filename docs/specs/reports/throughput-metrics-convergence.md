# Convergence Report — Worker Blocker-Lifecycle Beacon and Metrics

## Cross-model review: codex-cli:gpt-5.5

Real external reviews ran through both Codex (`gpt-5.5`) and Gemini (`gemini-3.1-pro-preview`) on the final body. The final Gemini verdict was clean-with-minor-notes and the final Codex verdict was minor-issues only; neither reported a material defect. One earlier Gemini round timed out, but successful Gemini rounds occurred before and after it. The code-backed Standards-Conformance Gate was attempted with both worktree path and markdown submission; the live service rejected the worktree request, so that advisory input is recorded as unavailable rather than silently claimed.

## ELI10 Overview

Workers already tell Instar exactly which promise has become blocked. This design makes that existing update measurable. It records how long the update takes to reach the durable commitment file and how long the blocker stays open. It does not guess which promise the worker meant, rank workers, combine the measurements into a score, notify anyone, or take action.

Review found that the existing commitment store could report success even when its file write failed. The converged design repairs that first: a write reports success only after its authoritative rename, and failed writes restore memory. Metric delivery remains secondary and can fail without changing the worker's real state. Clear measurements can be repaired after restart; request timing is explicitly best-effort and exposes missing coverage.

## Original vs Converged

The original broad design tried to measure five factors, including three whose producers did not exist on current main. It also proposed a Stop-hook token, inferred session-to-commitment focus, and a combined 0–100 estimate. Those were removed. The final v1 uses the worker's existing explicit commitment transition, exactly two raw factors, and no scalar or autonomous behavior. The three floor-dependent factors and any combined index are a named post-floor increment.

The first narrowed draft still invented a focus registry and a beacon-only filesystem lock. Source inspection proved the lock would not coordinate with ordinary tracker writes, and the operator ruled that the explicit transition itself is the beacon. The focus/token/lock subsystem was deleted. Later foundation review found swallowed persistence failures, overwritable single-episode state, unbounded retry behavior, incomplete multi-machine reads, and ambiguous API math. The converged spec adds acknowledged persistence with safe CAS/batch rollback, bounded retained episode history, explicit best-effort coverage, retry brakes, origin-owned replication semantics, unified bounded reads, and closed schemas/outcome tables.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | external Codex/Gemini and source audit | 5 | Removed unsupported factors and scalar; corrected locking assumptions; added raw-only factors and bounded lifecycle design. |
| 2 | operator semantics ruling | 4 | Deleted Stop hook, token, and focus registry; made the existing explicit transition the beacon; renamed first factor to `request-to-persist`. |
| 3 | six-perspective internal reviewer | 12 | Added observable persistence acknowledgement, best-effort request semantics, bounded episode history, privacy-safe ids, P19 brakes, numeric gates, one-origin replication, and pinned routes. |
| 4 | six-perspective internal reviewer | 3 | Corrected oscillating verified/violated semantics, unified multi-machine reads, and complete factor/trend schemas. |
| 5 | six-perspective internal reviewer | 4 | Fixed async rollback timing, transactional sweep batching, origin-local timing start, and outcome/window classification. |
| 6 | six-perspective final/delta review | 0 | Converged; only non-material precision and clarity edits remained. |

## Full Findings Catalog

### Unsupported scope and authority

- **Material — integration:** Three factors depended on an unmerged throughput-floor runtime. **Resolution:** v1 factor enum is closed to `request-to-persist|clear-latency`; the other three are tracked post-floor.
- **Material — misuse:** A two-factor scalar could be read as worker productivity. **Resolution:** no scalar, ranking, normalization, or action consumer exists.
- **Material — authority:** Session/focus inference could mutate the wrong commitment. **Resolution:** the already explicit, owner-routed transition is the only beacon; focus binding is a named follow-on only.
- **Material — integration:** A beacon-only file lock would not coordinate with ordinary tracker mutations. **Resolution:** that subsystem was removed.

### Persistence and episode durability

- **Critical — foundation/P6/P20:** `saveStore()` swallowed failure, so return was not proof of persistence. **Resolution:** observable rename result, typed failure, complete-store rollback, no success/event before acknowledgement, and failure-injection tests.
- **Material — concurrency:** An async pre-await snapshot could erase another committed mutation. **Resolution:** snapshot occurs only after await and successful CAS, immediately before the no-await apply/save section.
- **Material — batching:** existing sweep batching returned before rename. **Resolution:** explicit batch transaction with pre-batch snapshot, deferred private results/events, one acknowledged flush, or whole-batch rollback.
- **Material — reconstructability:** a single episode could be overwritten before reconciliation. **Resolution:** bounded 64-entry retained history plus monotonic clear-confirmation marker and capacity-pressure/drop accounting.
- **Material — measurement honesty:** exact monotonic request duration cannot be persisted inside the rename it measures. **Resolution:** request factor is best-effort with `recoverability:'best-effort'` and durable missing-coverage detection; clear factor is reconcilable.

### Failure loops, clocks, and capacity

- **Material — P19:** fixed five-minute retries under permanent SQLite failure were unbounded amplification. **Resolution:** closed exponential backoff, six-failure breaker, bounded recovery probe, and hourly deduped audit.
- **Material — clocks:** wall time can regress even on one machine. **Resolution:** monotonic request duration; negative or >30-day clear spans are null/excluded.
- **Material — capacity:** a dropped episode needed non-duplicating open/clear accounting. **Resolution:** one current dropped marker pairs request missing at open with clear missing at close; daily content-free buckets bound retention.
- **Minor — scaling:** co-located histories increase JSON writes. **Resolution:** 48-entry pressure guard, 64 hard bound, bounded transition history, explicit co-location rationale, and numeric route-latency soak gate.

### Multi-machine, security, and interface

- **Material — P21:** local-only read visibility fragmented the agent. **Resolution:** authenticated bounded `scope=pool` returns per-origin component truth with explicit completeness and no fleet aggregate.
- **Material — replication:** conflict behavior was initially unspecified. **Resolution:** commitments have one origin writer; remote mutation forwards to origin; replicas are authenticated read copies with incarnation fencing and never merge back.
- **Material — privacy:** commitment-derived source hashes were correlatable. **Resolution:** opaque episode UUID + versioned event kind only; responses allowlist aggregates and enums.
- **Material — API completeness:** factor objects, coverage, outcomes, sparse cases, and trend null reasons were unpinned. **Resolution:** closed v1 shapes, examples, classification table, window timestamps, safe-integer/null rules, status codes, and peer-failure enums.
- **Minor — external reviewers:** broader storage change, terminology density, custom descriptive trend, pool complexity, and OpenTelemetry alternatives warrant caution. **Resolution:** increment 0 is independently reviewable/revertible with its own release note; terminology/assumptions and design rationale are explicit. Trend is descriptive-only, pool computes no fleet statistic, and standard observability remains a future option after the five-factor system proves need.

### Decision completeness and lessons

- Four decisions are frontloaded: exact v1 boundary; persistence/episode contract; metric/read/rollout contract; named follow-ons. No `cheap-to-change-after` tags or unresolved questions remain.
- Lessons-aware review explicitly checked Signal vs Authority, Zero Failure, Verify State Not Symbol, No Unbounded Loops, Multi-Machine, Migration Parity, Testing Integrity, Distrust Temporary Success, and state-detection robustness.
- Local feedback memory files were unavailable in the expected worktree/project locations; this reduced input is disclosed. The canonical lessons document and one-layer-below tracker/sync foundation were reviewed.

## Convergence verdict

Converged at iteration 6. The final six-perspective internal round and final delta check found zero material issues. Both available external model families successfully reviewed the final body; their remaining findings were non-material cautions recorded above. The spec has no open operator decisions and is ready for the pre-authorized build.

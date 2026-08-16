# Architecture Review: Cross-Agent Telemetry
**Review ID:** 20260321-232336
**Round:** 1
**Spec:** `specs/cross-agent-telemetry.md`
**Reviewer:** Echo (systems architect mode)
**Date:** 2026-03-21

---

## Executive Summary

The spec is well-conceived and appropriately scoped. The phased approach is correct, the privacy architecture is sound, and the choice to collect first and analyze later reflects hard-won wisdom about premature analytics infrastructure. There are no fundamental design errors. The issues I raise are mostly about operational specifics, one significant backend architecture concern, and a data fidelity gap that could undermine the whole system if not addressed early.

**Verdict:** Ready to implement Phase 1 with four targeted adjustments before coding starts.

---

## Research Findings

### Cloudflare Durable Objects for Telemetry Aggregation

Cloudflare's own Threat Intelligence Platform uses a sharded SQLite-backed DO architecture with fan-out queries — not a single DO per installation. The key finding: **one DO per installation ID is a scaling trap.** DOs have storage limits (currently 10GB per object) and more importantly, cross-installation aggregation queries ("what is the fleet-wide skip rate for job X?") become expensive fan-out operations when data is partitioned by installation rather than by metric type or time window. The Cloudflare reference architecture for analytics explicitly recommends control-plane/data-plane separation — a routing Worker that shards writes to many DOs and aggregates reads across them.

For Phase 1 (just storing raw submissions), per-installation partitioning is fine. But the spec should acknowledge that the query pattern for Phase 2 ("population stats for job X") is cross-installation and will require either a different storage layout or a materialized view layer.

### OpenTelemetry / StatsD Pre-aggregation vs Raw Submission

OTel's data model distinguishes between raw events and pre-aggregated timeseries. StatsD's default aggregation interval is 60 seconds; OTel recommends pre-aggregating at the collection point rather than shipping raw events to the backend. The key insight: **p50/p95 cannot be merged after pre-aggregation without the original distribution.** If agents compute and submit p50/p95 locally per 6-hour window and the backend tries to compute a population p95, it's computing "median of medians" — statistically invalid for non-uniform distributions. This is a known failure mode in distributed metrics systems.

The spec proposes collecting `p50Ms, p95Ms` per job per submission window. This is a data fidelity problem that must be resolved in the schema design.

### JSONL as a Transparency Log Format

JSONL is the right choice for the local transparency log. It is append-only by nature (no locking needed), human-readable, recoverable after partial writes (one bad line doesn't corrupt the file), and trivially parseable. The existing instar codebase already uses JSONL extensively for `job-runs.jsonl`, `skipped-runs.jsonl`, etc. — this is a natural fit. The main operational concern with JSONL is unbounded growth, which the spec addresses with 30-day retention on the backend but leaves unspecified for the local log. The existing `jsonl-truncator.ts` in `src/monitoring/` suggests this is a solved problem in the codebase — it should be applied here.

### TelemetryHeartbeat.ts Pattern

The existing implementation is clean and well-disciplined: 3-second fire-and-forget timeout, `unref()` on the interval (won't block process exit), no PII, transparent local logging via `appendFileSync`, EventEmitter for testability. The in-memory counter approach (`jobsRun`, `sessionsSpawned`) is simple but has a gap: counters reset on process restart. For an always-on daemon this is acceptable. For agents that restart frequently, the 24h counter will be inaccurate. This is worth noting in the spec as a known limitation rather than a bug to fix.

---

## Technology Choices

### Cloudflare Worker + Durable Objects

**Justified** for Phase 1. Zero-infrastructure, globally distributed, generous free tier for low-volume telemetry. The existing heartbeat infrastructure already uses this stack, so there's no new vendor dependency.

**Concern:** The spec says "store raw submissions in Durable Objects (keyed by installation hash)." This is correct for Phase 1 but actively wrong for Phase 2's query pattern. `GET /telemetry/population/:slug` is a cross-installation scan. Keying by installation means the backend must enumerate all DOs to answer that query — O(N installations) fan-out. At 10-50 agents this is fine. At 500 it becomes a problem.

**Recommendation:** Add a note to Phase 1 that the DO key structure should be designed with Phase 2's access pattern in mind. Consider a dual-write: raw submission in per-installation DO, plus async write to an R2 object or a separate "by-job-slug" aggregation DO that accumulates population data. This is one architectural decision that is expensive to undo after data accumulates.

### New Endpoint vs Extending Heartbeat

The spec proposes a new `/v1/telemetry` endpoint rather than extending `/v1/heartbeat`. This is correct. The payloads are structurally different (heartbeat is agent identity/health; this is job behavior data), the submission logic differs (heartbeat is always-on at basic level; telemetry is opt-in at a different consent tier), and keeping them separate preserves the ability to evolve each independently.

### Local JSONL Transparency Log

Sound choice. One gap: the spec's proposed log entry omits the actual payload:

```json
{
  "timestamp": "...",
  "metricsSubmitted": { "jobCount": 23, "featureFlags": 5 },
  "endpoint": "v1/telemetry",
  "responseStatus": 200
}
```

`metricsSubmitted` is a summary, not the payload. For genuine transparency (design principle #4), the log should include the full submitted payload. Users should be able to verify exactly what left their machine. The existing `logHeartbeat()` implementation does this correctly — it logs the full payload object. The new telemetry log should match that pattern.

---

## System Design

### Component Boundaries

The proposed split is clean:
- `TelemetryCollector.ts` — reads ledger files, computes aggregate metrics
- `TelemetryHeartbeat.ts` — extended with job/agent metric collection and submission

One concern: `TelemetryCollector.ts` reads `job-runs.jsonl` and `skipped-runs.jsonl` directly. This creates a hidden coupling — TelemetryCollector must understand the internal format of SkipLedger and JobRunHistory. If those formats evolve, TelemetryCollector breaks silently.

**Better boundary:** `JobRunHistory` and `SkipLedger` should expose query methods that `TelemetryCollector` calls, rather than TelemetryCollector parsing raw JSONL. Both classes already have query methods (the SkipLedger file shows `recordSkip`, and JobRunHistory has pagination/filtering). A `getMetricsForWindow(windowStart: Date, windowEnd: Date)` method on each class would be the right interface. TelemetryCollector aggregates; the scheduler classes own their data formats.

### Data Flow

The submission window concept ("per submission window") is sound but underspecified. The 6-hour window is clear, but the spec doesn't say whether windows are:
- **Rolling**: last 6 hours before submission time
- **Fixed**: 00:00, 06:00, 12:00, 18:00 UTC

This matters for longitudinal consistency. Fixed windows enable comparing submissions across installations (e.g., "what happened in the 06:00-12:00 UTC window across the fleet?"). Rolling windows are simpler to implement but make cross-installation comparison harder. Given Phase 2's stated goal of population analysis, **fixed windows are worth the implementation cost.**

### Counter Reset Gap

The existing heartbeat's in-memory counters reset on process restart. The spec proposes collecting durations (p50Ms, p95Ms) from the ledger data — this is better, since ledger data survives restarts. However, other metrics like `sessionsLast24h` appear to be in-memory counters. The spec should be explicit about which metrics come from durable ledger reads vs. in-memory accumulation, and note the restart-loss limitation for the latter.

---

## API Design

### Submission Protocol

The payload structure is reasonable. A few observations:

**`window` field**: `"window": "6h"` is underspecified. Is this the duration of the window, or an identifier for the window? If agents send multiple windows in one submission (catch-up after downtime), the backend needs to know the start time of each window, not just its duration. Recommend: `"windowStart": "2026-03-22T06:00:00Z", "windowEnd": "2026-03-22T12:00:00Z"`.

**Payload versioning**: The spec doesn't version the telemetry payload. The heartbeat uses `"v": 1`. The telemetry endpoint should do the same. Backend can reject unsupported versions cleanly rather than silently misinterpreting.

**Response `nextSubmissionAfter`**: Good design — server can throttle or request more frequent data. But the client spec doesn't say what to do if this timestamp is in the past (agent was offline). Behavior should be explicit: submit immediately on next opportunity, don't backfill, don't skip.

**Idempotency**: No mention of idempotency. If an agent submits and gets a network timeout (no response received), it will retry at the next 6-hour tick. The backend would receive two submissions for overlapping windows. Given 30-day raw retention and Phase 1's "just store it" approach, this is acceptable — but should be noted so Phase 2's analysis accounts for potential duplicate windows.

### Local API (`GET /telemetry/submissions`)

Reasonable. Should return submissions in reverse chronological order with a configurable limit. The existing server pattern for similar endpoints (e.g., job run history) should be followed exactly.

---

## Data Architecture

### The p50/p95 Problem (High Priority)

The spec collects `p50Ms, p95Ms` per job per submission window. **This is statistically invalid for fleet aggregation.** You cannot compute a fleet p95 from per-agent p95 values without knowing the underlying distributions. Averaging p95s gives you the mean of the 95th percentiles — a number that doesn't correspond to any meaningful statistical quantity.

Three options:
1. **Collect raw duration samples**: each job submission includes a list of durations. Accurate but potentially large payloads for high-frequency jobs.
2. **Collect histogram buckets**: collect counts of durations in fixed buckets (e.g., <100ms, 100-500ms, 500ms-2s, >2s). Histograms merge correctly — this is exactly what OTel and Prometheus use for this reason. Payload is bounded and fixed-size regardless of run count.
3. **Collect only mean + count**: sufficient for most practical "is this job getting slower?" questions at fleet level.

For Phase 1's goal (establish baseline, enable manual analysis), option 3 is simplest and statistically valid. Option 2 is the right long-term answer if actual percentile analysis at fleet level is needed. **Recommend: ship option 3 for Phase 1, note the histogram upgrade path in the spec.**

### Installation ID Collision Risk

`SHA-256(machineId + projectDir)` truncated to 16 hex chars = 64 bits. At 1,000 installations, collision probability is ~2.7e-14. Negligible. This is fine.

However, the spec notes the ID is used for "deduplication and longitudinal tracking." If a user reinstalls instar on the same machine in the same directory, they get the same ID — intentional. If they move their project directory, they get a new ID — possibly surprising. This is acceptable behavior but should be documented so Phase 2 analysis doesn't misinterpret a project move as a new installation.

### Feature Flags Schema

`"featureFlags": { "feature": enabled }` — the keys are feature names. This leaks the feature name set with every submission, which is fine (these are code-defined, not user-defined). But the backend needs a stable canonical list of valid feature names to detect new/removed features across versions. Worth noting in Phase 2 planning.

### Retention

30-day rolling retention on the backend is appropriate for Phase 1. The spec doesn't specify local log retention. The existing heartbeat log has no stated retention limit. Without a pruning mechanism, `telemetry/submissions.jsonl` grows unboundedly. Recommend: apply the same retention logic used by SkipLedger (30-day rotation on startup).

---

## Integration Points

### Ledger Dependency

TelemetryCollector reading `job-runs.jsonl` and `skipped-runs.jsonl` is a direct file dependency on the scheduler subsystem. This is the tightest coupling in the design. Acceptable for Phase 1 given that these are internal files and both are in the same process. The risk is that format changes break telemetry silently. Mitigate with the query-method interface boundary described above.

### Heartbeat Alignment

Submitting telemetry on the same 6-hour cycle as the heartbeat is efficient (one network round-trip worth of "agent is alive" signal) but means a heartbeat failure also silences telemetry. The spec says telemetry failure is fire-and-forget, but if the entire submission cycle is skipped due to a higher-level failure, that gap won't show up in the local log either. Low-risk for Phase 1 but worth noting.

### Backend Worker Extension

"Extend existing Cloudflare Worker" — the spec is appropriately brief here. The only concern is that the existing worker is presumably already deployed and serving the heartbeat endpoint. The new endpoint must be deployed carefully to avoid disrupting heartbeat processing. Standard Cloudflare Worker versioning/rollback applies. No additional concern.

---

## Operational Concerns

### Deployment

The client side (TelemetryCollector + extended TelemetryHeartbeat) deploys with the normal instar release. The Worker backend can be deployed independently. The spec's phased structure means Phase 1 backend can go live before any client is updated — the endpoint just won't receive traffic until agents update and opt in. This is the correct deployment order.

### Monitoring the Monitor

If the telemetry endpoint itself has an error rate or latency spike, how does Echo know? The Worker should emit its own metrics (Cloudflare Analytics Engine is purpose-built for this). Not a Phase 1 blocker, but worth noting in the implementation plan.

### Data Access for Echo

"Backend stores raw data, queryable by Echo for manual analysis" — the mechanism isn't specified. Options:
- Cloudflare Dashboard (Workers Analytics)
- Direct DO query via authenticated API endpoint on the Worker
- Export to R2 + local download for analysis

For Phase 1, the simplest approach is a protected admin endpoint on the Worker that returns raw JSON for a given installation ID or time range. This should be designed before launch, not after, because it's the only way to validate that data is flowing correctly.

---

## Complexity Budget

The spec is appropriately lean. Phase 1 adds:
- 1 new file (`TelemetryCollector.ts`)
- 2 modified files (`TelemetryHeartbeat.ts`, `Config.ts`)
- 1 new type interface set
- 1 Worker endpoint

This is a 3-4 day implementation. The complexity is proportionate to the value. No over-engineering is present. The phasing explicitly defers analytics, insights, and crowdsourcing — which is exactly right.

The one complexity risk is if the ledger-reading logic in TelemetryCollector becomes a mini query engine. Scanning 30 days of `job-runs.jsonl` on every 6-hour tick could be slow for busy agents. TelemetryCollector should track a file offset or last-processed timestamp to avoid full re-scans. This is standard append-only log processing and should be designed in from the start.

---

## Evolution Path

The phased structure is the strongest architectural decision in this spec. Each phase is independently valuable and doesn't foreclose the next. A few evolution notes:

**Phase 1 → Phase 2 gate**: Phase 2 requires population-level queries. As noted above, the DO key structure chosen in Phase 1 determines how hard this is. Plan the aggregation layer now, even if you don't build it.

**Phase 3 (Automated Insights)**: The response payload already includes `populationSize` — it's a short step to add `insights: []`. The schema is pre-adapted. Good forward thinking.

**Phase 4 (Evolution Crowdsourcing)**: This requires tracking proposal outcomes over time, which requires longitudinal installation identity. The installation ID design supports this. Phase 4 is the most privacy-sensitive and should have its own consent tier spec before implementation begins (the spec correctly defers to Topic 1895).

**Schema evolution**: No versioning is specified for the telemetry payload. Adding `"v": 1` to the submission payload (mirroring the heartbeat's `"v"` field) costs nothing now and is invaluable later when the schema changes.

---

## Issues Ranked by Priority

| Priority | Issue | Spec Section | Recommendation |
|----------|-------|-------------|----------------|
| HIGH | p50/p95 can't be fleet-aggregated | Data Collection | Replace with mean+count for Phase 1; histogram for Phase 2 |
| HIGH | Full payload missing from local transparency log | Local Log | Log full payload, not just summary counts |
| HIGH | DO key structure doesn't support Phase 2 query pattern | Backend | Design aggregation layer now; implement later |
| MEDIUM | `window` field underspecified | Submission Protocol | Use windowStart/windowEnd ISO timestamps |
| MEDIUM | No payload version field | Submission Protocol | Add `"v": 1` |
| MEDIUM | TelemetryCollector couples to raw JSONL format | Component Boundaries | Use query methods on SkipLedger/JobRunHistory |
| MEDIUM | Fixed vs rolling windows not specified | Data Flow | Specify fixed UTC windows for cross-installation comparability |
| MEDIUM | Local log retention not specified | Operational | Apply 30-day rotation matching SkipLedger |
| LOW | TelemetryCollector full-scan on each tick | Complexity | Track last-processed offset/timestamp |
| LOW | Admin query interface for Echo unspecified | Operational | Design authenticated admin endpoint before launch |
| LOW | Counter inaccuracy on process restart | Known Limitation | Document; ledger-derived metrics are not affected |
| LOW | Installation ID semantics on project move | Documentation | Note in user-facing docs |

---

## What the Spec Gets Right

- Privacy architecture is rigorous and well-specified. The "never collected" list is comprehensive and the SHA-256 non-reversibility is correctly described.
- Skip reason taxonomy is excellent. This is the most analytically valuable part of the data model and it's well-designed.
- Opt-in default with phased consent tiers is the right call, not the conservative call.
- Fire-and-forget with 3s timeout matches the existing heartbeat pattern and is correct.
- Phasing is disciplined. Phase 1 is genuinely minimal.
- Response payload with `populationSize` is a nice touch that gives consenting agents immediate value from their submission.
- Open questions section is honest and useful, especially the minimum population question.

---

## Summary Recommendation

Implement Phase 1 with these changes before coding:

1. Replace `p50Ms, p95Ms` with `meanMs, count` in the job metrics schema.
2. Log the full submitted payload (not a summary) in the local transparency log.
3. Add `windowStart`/`windowEnd` timestamps to the submission payload; add `"v": 1`.
4. Plan the backend aggregation DO structure before writing the Worker code — even if Phase 2 is months away, the data partitioning decision made in Phase 1 determines the cost of building Phase 2.

Everything else can ship and be iterated on. The foundation is solid.


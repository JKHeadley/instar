# Scalability Review: Cross-Agent Telemetry
**Review ID:** 20260321-232336
**Round:** 1
**Reviewer Role:** Scalability & Infrastructure Specialist
**Spec:** `/Users/justin/.instar/agents/echo/specs/cross-agent-telemetry.md`
**Date:** 2026-03-21

---

## Research Findings

Before diving into the spec analysis, here's what independent research surfaced:

### Cloudflare Workers
- **Free tier:** 100,000 requests/day, resets at midnight UTC
- **Paid tier:** $5/month base, then $0.30/million requests — effectively no ceiling
- No per-second rate limit on Workers (unlike Durable Objects)
- No egress/bandwidth charges — favorable for a telemetry collector

### Cloudflare Durable Objects
- **Critical constraint:** Each Durable Object is **single-threaded** with a soft limit of **1,000 requests/second**
- If overloaded, the object returns an error to the caller — it does not queue indefinitely
- Storage: 10 GB per object (paid), 5 GB total on free tier
- SQLite-backed storage billing began January 2026
- Unlimited number of objects per namespace — horizontal sharding is the idiomatic scaling pattern
- Cloudflare's own best-practices docs explicitly warn: **do not create a single "global" Durable Object** — this is their #1 anti-pattern

### Telemetry Aggregation at Scale
- The industry pattern (OpenTelemetry, PostHog, Plausible) is: aggregate at the edge, emit periodically, not per-event
- PostHog migrated from PostgreSQL to ClickHouse to handle billions of events — PostgreSQL breaks at ~10k MAU for analytics workloads
- Time-series data cost is driven by **resolution x cardinality** — finer resolution and more dimensions = exponential cost growth
- Pre-aggregation at the source (what this spec does with p50/p95 per window) is the correct instinct; raw event streaming is the anti-pattern

### Comparable Systems
- PostHog's open-source telemetry: opt-in phone-home, sends aggregate counts per day, not raw events
- Sentry's relay architecture: agents batch locally, compress, forward to a regional collector
- Commonality: **write fan-in is the hard problem** — thousands of agents all submitting simultaneously requires careful sharding

---

## Phase Assessment

| Phase | Agents | Submissions/6h | Request Rate | Key Bottleneck |
|-------|--------|----------------|--------------|----------------|
| MVP | 10–50 | 10–50 | Negligible | None — single DO works fine |
| Growth | 50–500 | 50–500 | <1 req/sec avg | DO keying strategy starts to matter |
| Scale | 500–5,000 | 500–5,000 | ~1–10 req/sec avg | Single DO for aggregation is a problem |
| Viral | 5,000+ | 5,000+ | Bursty, potentially hundreds/sec | Single aggregation DO hits overload ceiling |

---

## Findings

### 1. Durable Object Keying Strategy — Critical Design Gap

**Severity: HIGH**

The spec says: *"Store raw submissions in Durable Objects (keyed by installation hash)"*

This is the correct write pattern — one DO per installation avoids the fan-in problem for writes. Each agent writes to its own DO, so 5,000 agents = 5,000 DOs, each getting ~4 writes/day. That scales cleanly.

**The gap is on the read/aggregation side.** Phase 2 requires queries like `GET /telemetry/population/:slug` — "give me skip rates for job X across the entire population." To answer that, something must fan-out reads across potentially thousands of DOs, or maintain a separate aggregate DO/store. The spec doesn't address this at all.

**Failure mode:** At 500 agents, a naive population query that reads all installation DOs synchronously will hit Cloudflare's Worker CPU time limits. At 5,000 agents, it's completely infeasible without a pre-aggregation layer.

**Recommendation:** Design the aggregation layer now, even if you don't build it yet. Two viable patterns:
- **Write-time fan-in:** On each submission, update a per-slug aggregate DO in addition to the installation DO. Writes are cheap at current scale.
- **Background aggregator job:** A scheduled Worker that sweeps installation DOs and materializes aggregate stats. Works up to ~5,000 agents before sweep latency becomes painful.

---

### 2. Single Aggregation Point Risk

**Severity: HIGH**

If a central aggregate DO is introduced (per-slug or global), it becomes a write-time hotspot. Every agent submission writes to the same object. At 500 agents x 4 submissions/day = 2,000 writes/day, this is fine. At 5,000 agents, it's 20,000 writes/day (~0.2/sec average) — still within the 1,000 req/sec limit, but bursts matter.

**Burst scenario:** If agents self-sync after an outage (e.g., network partition followed by recovery), all agents may submit simultaneously. 1,000 agents waking up and submitting at once = 1,000 concurrent writes to the aggregate DO. This hits the Cloudflare overload threshold. The DO returns errors; telemetry is silently dropped (fire-and-forget means no retry). You lose a data window entirely.

**Recommendation:** If a central aggregate DO is used, add write-time jitter at the client (already partially addressed by `nextSubmissionAfter` in the response — use this actively to spread load, not just as a hint). Alternatively, use per-slug DOs rather than a single global aggregator.

---

### 3. JSONL Log Growth — Local Storage Rot

**Severity: MEDIUM**

The spec defines a local transparency log at `{stateDir}/telemetry/submissions.jsonl`. At 4 submissions/day, this grows at ~4 entries/day per agent indefinitely. The spec specifies 30-day rolling retention on the backend but says nothing about local log retention.

**Failure mode:** After 1 year of telemetry enabled, an agent has ~1,460 JSONL entries. After 5 years: ~7,300. Not a disk problem (it's tiny), but it is a management problem: `GET /telemetry/submissions` with no pagination or retention policy becomes a sprawling dump that's hard to reason about.

**Recommendation:** Add a local retention policy to the spec. 30 days of local submissions is sufficient for audit purposes. The `TelemetryCollector.ts` implementation should truncate on write.

---

### 4. Payload Size Growth — Cardinality Creep

**Severity: MEDIUM**

The per-job metrics array grows linearly with job count. The spec mentions agents can have 23+ jobs (from the example: `"jobCount": 23`). Each job contributes ~5 metric rows (skip, results, durations, model, schedule adherence). At 23 jobs, a payload might be 30–50 KB of JSON. That's fine.

**But Phase 4 evolution crowdsourcing** adds "track which evolution proposals stuck vs reverted." Evolution proposals could multiply payload size significantly — a busy agent might have dozens of active proposals. The spec doesn't bound this.

**More immediate concern:** Feature flags are submitted as `{ feature: enabled }`. As instar adds capabilities, this map grows. No bound is stated. At 50 features, this is a rounding error. At 500 features (unlikely but not impossible for a mature platform), this is noise.

**Recommendation:** Add explicit payload size limits to the spec and enforce them in `TelemetryCollector.ts`. A 100 KB hard limit per submission is reasonable. Document what gets truncated if over limit.

---

### 5. Backend Cost Model — No Ceiling Defined

**Severity: MEDIUM**

The spec uses Cloudflare Workers (free: 100k req/day) and Durable Objects (paid: $5/month base + storage charges from Jan 2026).

Current cost profile at 50 agents:
- Requests: 50 x 4/day = 200 req/day — well within free tier
- Storage: 50 agents x ~1 MB each (30 days of 6h submissions) = ~50 MB — negligible

Cost profile at 5,000 agents:
- Requests: 5,000 x 4/day = 20,000 req/day — still free tier
- Storage: 5,000 agents x ~1 MB each = ~5 GB — approaching the paid threshold on the free plan, safely under the 10 GB/object limit per agent DO

There is no cost cliff in this design under the current architecture. Workers pricing is linear and cheap. Storage is the main variable, and 30-day rolling retention keeps it bounded.

**The actual cost risk is Phase 2 queries.** Population queries that fan-out across thousands of DOs generate many Worker invocations. Each `GET /telemetry/population/:slug` might fan out to 5,000 Worker sub-requests. At $0.30/million, that's still $0.0015 per population query — trivial. But it's worth acknowledging.

**Recommendation:** Document expected cost in the spec so Echo can catch it if it drifts. Add a backend cost estimate section. The current numbers are very favorable.

---

### 6. Submission Window Alignment — Clock Drift Risk

**Severity: LOW**

The spec states 6-hour submission windows "aligned with existing heartbeat." In practice, agent clocks drift, restart offsets accumulate, and users may enable telemetry at arbitrary times. The current `nextSubmissionAfter` response field partially addresses this, but the spec doesn't define what "aligned" means precisely.

**Failure mode:** If agents all start at 00:00 UTC and submit every 6h, you get four daily spikes at 00:00, 06:00, 12:00, 18:00 UTC. With 5,000 agents, these spikes are ~5,000 simultaneous requests to the Worker in a short window. This is fine for Workers (no per-second rate limit) but bad for any aggregate DO writes.

**Recommendation:** The `nextSubmissionAfter` response should actively spread agents out. When a new agent submits for the first time, return a randomized initial delay (0–6 hours). This is a one-line fix at the server level and prevents any burst clustering.

---

### 7. No Backpressure Signal to Client

**Severity: LOW**

The spec's response format includes `nextSubmissionAfter` but no explicit backpressure signal. If the backend is overloaded or under quota pressure, the client has no way to know to back off or skip future windows.

**Recommendation:** Add an optional `backoff: true` field to the response. If the server returns this, the client doubles its interval for the next window. This costs nothing to implement and provides graceful degradation during any unexpected load spike.

---

### 8. Installation ID Collision Space

**Severity: LOW (non-issue)**

The installation ID is `SHA-256(machineId + projectDir)` truncated to 16 hex characters. 16 hex chars = 64 bits of entropy. With 5,000 agents, the birthday collision probability is ~(5000^2) / (2 x 2^64) — approximately 6.8 x 10^-13. Effectively zero. At 1 million agents: ~2.7 x 10^-8. Still negligible. No action needed.

---

## Summary Table

| Finding | Severity | Phase Triggered | Effort to Fix |
|---------|----------|-----------------|---------------|
| No aggregation layer design for population queries | HIGH | Growth (500+) | Medium — needs architecture decision now |
| Single aggregate DO burst risk | HIGH | Scale (5,000+) | Low — jitter + sharding |
| Local JSONL log has no retention policy | MEDIUM | Any | Low — one-liner in TelemetryCollector |
| Payload size unbounded, cardinality creep | MEDIUM | Scale+ | Low — add size cap |
| Backend cost model undocumented | MEDIUM | N/A (informational) | Low — document it |
| Submission clock clustering | LOW | Scale (5,000+) | Low — random initial delay |
| No backpressure signal | LOW | Scale+ | Trivial |
| Installation ID collision | LOW (non-issue) | Never | No action needed |

---

## Recommended Spec Additions

These are gaps that should be addressed before Phase 2 is designed:

1. **Aggregation architecture decision** — Define whether population queries will use write-time fan-in (aggregate DOs updated on each submission) or a background sweep job. This determines whether Phase 2 is buildable without a backend rewrite.

2. **Local log retention** — Add `maxLocalSubmissions: 120` (30 days x 4/day) to the config schema, with truncation on write.

3. **Payload size cap** — Explicitly bound the submission payload. Recommended: 100 KB limit, with truncation of the `jobs` array if needed (most-recent jobs first, oldest dropped).

4. **Submission spreading** — Specify that the server should return a randomized `nextSubmissionAfter` on first submission to spread the fleet across the 6-hour window.

5. **Phase 2 data access design** — Before Phase 1 is complete, sketch the query patterns for Phase 2. The data model must support them. Storing raw submissions keyed by installation works for single-agent history but requires a separate index for population queries.

---

## Overall Assessment

Phase 1 as specified is sound for MVP to Growth scale (10–500 agents). The fire-and-forget architecture, opt-in defaults, pre-aggregation at the client, and per-installation DO keying are all correct decisions. The cost model is favorable.

The primary risk is that Phase 1's data model — raw submissions keyed by installation — is a poor foundation for Phase 2's population queries. This should be addressed now, before Phase 1 is built, because retrofitting an aggregation layer requires schema changes and backfill logic. The gap is not large, but it needs a decision.

The secondary risk is burst handling at the DO layer during recovery scenarios. The `nextSubmissionAfter` mechanism exists but needs to actively spread load rather than serving as a passive hint.

Everything else is manageable in the normal course of development.

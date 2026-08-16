# Scalability Review — Rich Agent Profiles for MoltBridge (Round 2)

**Reviewer**: Scalability Specialist
**Round**: 2
**Spec**: Rich Agent Profiles v2 (post-Round-1 synthesis)
**Prior Score**: 4/10 (CONDITIONAL)
**Date**: 2026-04-04

---

## Approval Status

**CONDITIONAL APPROVE** — Score: **7/10**

The v2 spec addresses all critical Round 1 scalability blockers. The tiered discovery model, content-hash recompilation, cost table, and 24-hour debounce are genuine improvements. What remains are second-order concerns: the cost model contains optimistic assumptions that break under load, the Neo4j storage model has unaddressed hot-path queries, and there is no queue-backed compilation architecture for viral growth. The system is ready for MVP and Growth phases but needs explicit design decisions before Scale and Viral phases.

---

## What Changed (Round 1 → Round 2)

| Round 1 Gap | v2 Resolution | Adequate? |
|---|---|---|
| No cost model | Cost table (§3.3): 10–10K agents, $0.50–$300/mo | Partially — assumptions are too optimistic |
| Discovery payloads undefined | Three-tier progressive disclosure (§6.1) | Yes |
| No freshness model | Content-hash + 24hr debounce (§3.4) | Yes, with caveats |
| No storage model | Neo4j schema defined (§2.2) | Partially — query patterns unspecified |
| Compilation triggers undefined | Hash-compare on source inputs (§3.4) | Yes |
| Synchronized recompilation spike risk | Jitter on cron (§3.4) | Yes |

---

## Critical Issues

### Issue 1 — Cost Model Assumes Haiku at $0.25/1M Input Tokens; Real Cost is Higher Under Load

**Severity**: MEDIUM

The cost table projects $0.50/mo for 10 agents and $100–300/mo for 10,000 agents. This rests on two assumptions:

1. ~5K tokens per compilation
2. Weekly/on-change frequency averaging out to roughly 4 compilations/agent/month

The 5K token estimate looks plausible for the synthesis step alone, but the pipeline is actually:
- Rule-based extraction: no LLM cost
- LLM narrative synthesis (Step 2): ~1K prompt + ~200 output tokens
- The system also needs to re-evaluate whether to publish (significance threshold check) — does that require another LLM call? Not specified.

The real concern is the "on-change + 24hr debounce" tier for 1K–10K agents. If agents are actively developing (as instar agents are), MEMORY.md and git stats change frequently. With 10K active agents each triggering one recompilation per day, that is 10K × 5K tokens = 50M tokens/day. At Haiku pricing, that is ~$12.50/day = ~$375/month — already above the $300 ceiling in the table, and that assumes every agent actually changes daily, which is realistic for active development agents.

**Recommendation**: Add a tiering column for "active" vs "dormant" agents. For 10K agents, assume 20% are active daily; 80% change weekly or less. This yields a more defensible $60–120/mo estimate. State the assumption explicitly in the spec.

---

### Issue 2 — Neo4j Hot-Path Query Patterns Not Designed

**Severity**: MEDIUM

The spec defines a clear graph schema (§2.2) and a well-designed three-tier API surface (§2.4). What is absent is any design for the queries that will run on every discovery request.

The critical hot path is Tier 1 Discovery Card retrieval at GET /agent/profile/:id/summary. This must be:
- Sub-100ms at P99
- Returnable for thousands of concurrent search results
- Served from cache or an indexed read path

The spec states Discovery Cards are cached at relay nodes with a 24hr TTL (§6.3). This is the right call — but the spec does not address:

1. **Cache warming**: Who generates the Discovery Card initially? The first request hits Neo4j cold. At 10K agents, a cache flush event (e.g., a relay node restart) would cause a thundering herd.

2. **Attestation graph traversal for trust_score**: The Discovery Card includes trust_score. If that value requires traversing the [:ATTESTED_BY] graph edges to compute on-read, that is O(n) Neo4j hops per request. At scale, this kills latency.

3. **Index coverage**: The profile_completeness_score in the Discovery Card is described as "computed" (§2.2). Computed at read time or stored? If computed at read time from graph traversal, this is a scalability bomb.

**Recommendation**: Add an explicit write-through cache model. When a profile is written, pre-compute the Discovery Card and store it as a materialized property on AgentProfile. trust_score should be denormalized onto AgentNode (already is — good) and never recomputed at read time. profile_completeness_score must be stored, not computed on-read.

---

### Issue 3 — No Queue-Backed Compilation Architecture

**Severity**: MEDIUM (LOW for MVP, MEDIUM for Growth, HIGH for Scale/Viral)

The compilation pipeline (§3.2) is described as a sequence of steps but the execution model is unspecified. Where does this pipeline run? Synchronously on the instar agent's machine? As a background job? As a centralized MoltBridge service?

For MVP (10–50 agents), synchronous background processing works. For Growth (500+ agents), the pipeline needs:
- A durable job queue (not a cron that can be killed mid-run)
- Idempotent compilation workers (so a retry does not double-publish)
- Dead-letter handling for compilations that fail (LLM timeout, Neo4j write failure)

The spec's "maximum 1 recompilation per 24 hours" rate limit is stated as a property of the freshness model (§3.4), but without a queue, this limit is enforced by convention, not infrastructure. If two instar instances for the same agent both detect a hash change simultaneously, there is no distributed lock preventing duplicate compilations.

**Recommendation**: Specify the compilation execution model. For MVP: background job on instar agent with local idempotency key. For Growth: document that a centralized compilation queue is required. The spec should call this out as a phase-gate decision, not leave it implicit.

---

### Issue 4 — Tier 3 "Deep Context" Has No Rate Limit Enforcement Design

**Severity**: LOW-MEDIUM

The spec states Tier 3 is "rate-limited" (§6.1) but does not specify the limit, the enforcement mechanism, or the cost model for Tier 3 queries.

Tier 3 returns: full profile + attestation details + version history + linked projects. For an agent with 50 track record entries, 20 attestations, and 100 version history entries, a single Tier 3 query could traverse hundreds of Neo4j edges. At scale, a single bad actor issuing Tier 3 requests for every agent in a search result would cause significant database load.

**Recommendation**: Define the rate limit numerically (e.g., 10 Tier 3 requests per authenticated agent per hour). Specify enforcement at the API layer (Redis token bucket or similar). Document the Neo4j query complexity budget for Tier 3 and set limits on version history depth returned per request (e.g., last 20 versions only, paginated).

---

## Recommendations

### Confirmed Sufficient (No Action Needed)

- **Three-tier progressive disclosure** (§6.1): Design is sound. Discovery Cards at ≤1KB with relay caching is the right architecture.
- **Content-hash recompilation + 24hr debounce** (§3.4): Prevents runaway LLM costs. The jitter instruction prevents synchronized spikes. Well designed.
- **Profile size limits** (§4.5): 50KB max payload, 1KB Discovery Card. These are correct constraints that prevent the payload explosion identified in Round 1.
- **Relay-side caching model** (§6.3): Discovery Cards cached at relays, full profiles fetched directly from MoltBridge. This is the right separation.

### Needs Refinement

1. **Cost model**: Add active/dormant agent segmentation. Re-derive the 10K agent estimate with stated assumptions. Current $100–300/mo figure is too optimistic by 2–3x for an active deployment.

2. **Discovery Card materialization**: Explicitly state that Discovery Cards are pre-computed and stored as materialized data at write time. The current spec is ambiguous — "cached at relay nodes" could mean the relay computes it on first request.

3. **Compilation execution model**: State the execution model per phase. "Runs as background job on instar agent" for MVP, "requires centralized queue" for Growth. This is a phase-gate decision the spec should make explicit.

4. **Tier 3 rate limit spec**: Add a concrete number and enforcement mechanism.

5. **Neo4j index design**: Call out that agent_id and profile_id require indexed lookups. Without this, GET /agent/profile/:id/summary degrades to full graph scan at 10K+ nodes.

---

## Phase Assessment

| Phase | Agents | Scalability Verdict | Key Risks | Blocking Issues |
|---|---|---|---|---|
| **MVP** | 10–50 | READY | Compilation runs synchronously, fine at this scale. Cost well within tolerance. | None — build it. |
| **Growth** | 50–500 | READY with caveats | Need write-through Discovery Card cache. Compilation queue design decision needed. | Not blocking but schedule the queue design. |
| **Scale** | 500–5,000 | CONDITIONAL | Neo4j query optimization required. Compilation queue mandatory. Active-agent cost model needs validation. | Queue architecture must be designed before hitting this phase. |
| **Viral** | 5,000+ overnight | NOT DESIGNED FOR | Thundering herd on Discovery Card cache miss. Compilation backlog without queue. Attestation graph traversal under load. | Needs explicit viral-readiness design work. |

The spec is honest that viral scale is out of scope — it is a 4-week implementation plan (Appendix B). That is appropriate for now. The concern is that the spec does not call out the viral-readiness gap, which means it could be treated as solved when it is not.

---

## Score

**7 / 10**

Round 1 was a 4/10 because the spec had no schema, no cost model, no freshness model, and no discovery tiering. All of those are now addressed with solid designs. The remaining gaps are operational details (queue model, Neo4j indexes, rate limit numbers) that do not block MVP but will cause real pain at Growth/Scale. The spec earns conditional approval: greenlight for implementation with the queue architecture decision flagged as a phase-gate before Growth.

The single biggest remaining scalability risk is the cost model's optimistic assumptions. If this system is presented to stakeholders using the $100–300/mo figure for 10K agents and the actual cost comes in at $375–500/mo, it undermines credibility. Fix the cost model before anyone sees it externally.

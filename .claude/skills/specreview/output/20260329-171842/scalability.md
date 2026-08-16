# SpecReview: Scalability & Infrastructure
## Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-171842
**Date**: 2026-03-29
**Round**: 5
**Reviewer**: Scalability & Infrastructure Specialist
**Spec Version**: v0.4.0
**Prior Round Score**: 7.5/10 (Round 4 scalability reviewer)

---

## Approval Status

**CONDITIONAL APPROVE — 8.2/10**

Material progress since Round 4. The three P1 scalability items (relay HA, super-node mitigation, offline queue behavior) are now addressed in the spec text. The architectural pattern for each is correct. What remains are implementation details that the spec defers appropriately — but several of those deferrals create risks if not tracked explicitly. One new issue identified: the relay HA design is placed in Phase 6 with implementation deferred to "Phase 7 (post-hardening)," which means the relay could operate as a single-instance SPOF through multiple production phases. This deferral strategy is acceptable only if traffic projections stay within the single-instance envelope, which the spec does not verify.

---

## Research Findings

Research conducted prior to writing this review. All claims below are sourced.

### Neo4j Super-Node Performance

**Finding**: Super-node query degradation is real and well-documented. Neo4j must assess all connections from a traversed node to find the next node in the path. For a node with 10,000 relationships, this means scanning all 10K relationship records on every traversal that passes through that node.

**Benchmark data**: Relationship-heavy queries show order-of-magnitude degradation. A query joining employees to companies (2.2M employees, standard relationship density) went from 700ms to 6.5 seconds when relationship traversal was included. For a super-node with 10K+ relationships, traversal queries can reach multi-second latency without pre-computation.

**The write-contention problem is underappreciated in the spec**: MERGE operations on Neo4j lock both source and target nodes for the transaction duration. High-degree nodes become transaction bottlenecks under concurrent writes — every new relationship to a popular agent locks that node. This is worse than the read-side degradation and is not addressed in the spec's mitigation.

**Mitigation validation**: The spec's proposed mitigation (pre-computed centrality scores via batch job, materialized trust scores at >500 degree threshold) is the correct pattern. GDS graph projections serve as materialized views and are the standard Neo4j recommendation for analytics on high-degree nodes.

**Research sources**: Neo4j community forums, Justin Boylan-Toomey's super-node analysis, Neo4j GDS documentation.

### WebSocket Relay Scaling (Fly.io)

**Finding**: Fly.io single-instance WebSocket capacity is configurable but bounded. Default hard_limit is 200 concurrent connections; production configurations run 20K–25K soft/hard limits. A single well-tuned Node.js instance can sustain 500K+ idle WebSocket connections with OS tuning (file descriptor limits, memory). However, Threadline is not idle connections — it processes messages, does PoW verification, manages presence, and runs FTS5 queries — so real capacity per instance is much lower.

**Fly.io multi-region behavior**: Fly.io routes WebSocket connections to the nearest region. Without a backplane, clients in different regions cannot exchange messages through the relay. This means multi-region deployment is not just a scaling option — it is required for correctness if agents in different regions need to communicate.

**Redis Pub/Sub backplane latency**: Redis pub/sub adds approximately 1ms latency per message hop. At 5,000 agents with moderate message rates, this is negligible. At 50,000+ agents with high-frequency messaging, Redis itself becomes the bottleneck and sharding or Streams migration is required.

**Redis Pub/Sub reliability gap**: Redis Pub/Sub is ephemeral — if a subscriber (relay instance) disconnects, it misses messages during reconnection. For an agent relay where message delivery is expected, this gap requires either Redis Streams (persistent, consumer groups) or a brief reconnection replay mechanism. The spec's "offline queue" is local to each relay instance; with Redis Pub/Sub, offline queue state must be replicated.

**Research sources**: Ably scaling guide, websocket.org architecture guide, Fly.io community forums, DEV community 2026 Redis+Socket.IO article.

### Infrastructure Cost Benchmarks

At 500 agents (Growth phase): Single Fly.io instance + Upstash Redis (or Fly Redis) — approximately $20–50/month total relay cost. Well within the spec's stated ~$20/month estimate.

At 5,000 agents (Scale phase): Multiple Fly.io instances across 2–3 regions + Redis cluster — approximately $150–400/month. The spec's $20/month figure is no longer valid at this scale. Cost cliff occurs somewhere between 500 and 2,000 agents when multi-instance deployment becomes necessary.

At 50,000+ agents (Viral): Managed Redis Cluster + 5+ relay instances + load balancer — approximately $1,000–3,000/month. Infrastructure cost likely exceeds revenue from discovery fees unless conversion rate to Layer 3 queries is high.

**Research source**: Ably cost benchmarks, AWS WebSocket API pricing ($750–4000/month at comparable loads), Fly.io pricing calculator.

---

## Phase-by-Phase Assessment

### MVP Phase (10–50 agents) — LOW RISK

Single-instance relay is entirely adequate. Neo4j with 50 agents has trivially low relationship counts. No super-node risk. PoW overhead is negligible. Discovery waterfall response times are within spec (5s relay timeout, 15s MoltBridge timeout). Local-first design is the right choice for this phase.

**Cost**: ~$20–30/month (relay + Neo4j AuraDB free tier or cheap instance). Well within spec.

**Verdict**: No issues.

### Growth Phase (50–500 agents) — MEDIUM RISK (improved from Round 4)

The spec now addresses the primary risk factors from Round 4:
- Queue-full behavior is defined (silent drop for untrusted, priority replacement for verified+, 429 response with Retry-After)
- Per-sender queue limits are defined (10 messages per sender in target's offline queue)
- Queue priority ordering is defined (trusted/verified delivered first, untrusted rate-limited to 5/min on flush)

**Remaining risk**: At ~200–300 agents with active message exchange, a single Fly.io instance approaches practical limits (not the connection count, but CPU on PoW verification + FTS5 queries). The spec's PoW ceiling (10x baseline, ~10s max) means during an attack spike at 300 active agents, legitimate reconnections could back up while PoW queue is processed. The spec does not define maximum PoW verification queue depth or timeout behavior for queued verifications.

**New issue — attestation write volume**: At 500 agents each submitting 2–3 attestations/day, Neo4j processes ~1,000–1,500 writes/day with MERGE operations that lock attestor and subject nodes. Not a problem at this scale, but the pattern is established here.

**Cost**: ~$20–50/month. Fine.

**Verdict**: ACCEPTABLE — minor gaps in PoW queue behavior, not blocking.

### Scale Phase (500–5,000 agents) — MEDIUM-HIGH RISK (improved from Round 4, new issues found)

**Relay HA placement is the primary concern.** The spec places relay HA design in Phase 6 and implementation in "Phase 7 (post-hardening)." Phases 1–6 could plausibly cover 12–18 months of development. If the system reaches 500+ agents before Phase 7, the relay is a single-instance SPOF with no backplane. The spec acknowledges this (Section 8, item 6: "architecture should assume eventual multi-instance") but does not define a capacity trigger that forces the Phase 7 implementation.

**What the spec gets right**:
- Multi-region Fly.io + Redis Pub/Sub backplane is the correct architectural prescription
- Neo4j super-node mitigation is specified (>500 degree → pre-computed score, batch job)
- Phase 6 explicitly calls for designing the relay HA architecture (even if implementation is Phase 7)

**What the spec misses**:
1. **Redis Pub/Sub offline queue replication**: The offline queue (1,000 messages, 7-day TTL, per-sender limits) is specified as a relay feature, but with multi-instance deployment, offline queue state must be shared. The spec does not address how the offline queue migrates to a Redis-backed distributed store when multi-instance deployment is activated. Agent A connects to relay-us-east; goes offline; Agent B (on relay-eu-west) sends 5 messages. Where do those messages queue? If each relay instance has its own local queue, the offline queue is instance-affine and messages are lost when the agent reconnects to a different instance.

2. **Neo4j write-contention super-node problem**: High-degree nodes (popular agents with 500+ relationships) become write-lock bottlenecks under concurrent attestation or relationship creation. The spec's mitigation addresses read-side (pre-computed scores for queries) but not write-side (MERGE lock contention). At 2,000 agents with 500 relationships each generating attestations concurrently, write throughput to super-nodes degrades. Recommended mitigation: batch relationship creation with debounce (e.g., aggregate attestations in a write buffer and flush in batched transactions), or use Neo4j's relationship property indexing to reduce relationship scan scope on writes.

3. **IQS cache coherence at scale**: The 1-hour TTL on cached IQS scores is fine at MVP. At 2,000 agents, the MoltBridge API processes O(2,000) cache refresh queries per hour (worst case all agents simultaneously expire). The spec does not specify staggered cache expiry or cache stampede prevention. All agents registered at approximately the same time (e.g., at a launch event) will have synchronized TTL expiry, creating thundering herd against the MoltBridge API.

4. **FTS5 directory search under load**: The Threadline relay's FTS5 full-text search directory is queried during discovery. The spec does not specify query rate limits on the FTS5 directory endpoint or index rebuild frequency. Under coordinated discovery traffic (e.g., many agents searching for the same capability simultaneously), FTS5 on SQLite can serialize — each query holds a shared lock during execution. At 500+ concurrent agents, this could become a serialization bottleneck.

**Cost**: $100–400/month. Growing but manageable with discovery fee revenue.

**Verdict**: CONDITIONAL — relay HA deferral is acceptable only with a defined capacity trigger. Offline queue replication design is a P1 gap.

### Viral Phase (5,000+ agents in days) — HIGH RISK (unchanged from Round 4)

The architectural foundation handles this correctly in theory (Fly.io autoscale, Redis backplane). The risk is the gap between "theory" and "implemented." During a viral spike:

1. **Relay autoscale lag**: Fly.io autoscale does not start new instances instantaneously. During the lag period, connection backpressure applies. The spec's backpressure design (priority queue for verified+, graceful rejection with Retry-After) is correct but only functional if the backplane is already deployed. If viral spike hits before Phase 7 implementation, there is no backplane and new instances cannot coordinate.

2. **PoW difficulty ceiling under coordinated spike**: The spec correctly caps dynamic difficulty at 10x baseline. A coordinated spike of 5,000 new registrations in one hour means 5,000 PoW challenges issued. At 10s max PoW (baseline × 10), the relay PoW verification queue processes completions sequentially. Throughput is bounded by CPU on the relay instance. The spec does not specify how many concurrent PoW verifications can be in-flight, or how the queue behaves when it fills.

3. **Neo4j registration spike**: 5,000 new agent registrations in hours means 5,000 new nodes + 5,000+ initial relationship creations (importing initial contacts, linking identities). Neo4j write throughput under sustained spike load needs to be profiled. AuraDB has instance-level write throughput limits that can queue at high write rates.

4. **MoltBridge Proof-of-AI bottleneck**: Each new registration requires a Proof-of-AI challenge. The spec doesn't address what happens when the PoA endpoint is under viral load. If PoA verification is rate-limited on the MoltBridge side, new agents cannot register. The spec specifies the error code (`REGISTRATION_RATE_LIMITED`) but not the behavior — do agents retry, queue, or fail permanently?

5. **Cost spike before revenue**: 5,000 new agents in days means infrastructure cost spikes immediately (relay instances, Neo4j writes, Redis throughput). Revenue from discovery fees lags until agents are registered, funded, and actively querying. The spec's cost structure ($20/month at MVP, ~$20-100/month at growth) does not model the cost of a viral spike event. At 5,000 registrations in 48 hours, transient infrastructure costs could reach $500–2,000 before any fee revenue arrives.

**Verdict**: HIGH RISK — not a blocker for Phase 1-6, but viral phase requires explicit capacity planning that is absent from the spec.

---

## Detailed Finding Catalogue

### FINDING 1 — Relay HA Phase Gap (P1, previously identified)
**Scale trigger**: ~500 concurrent agents
**Spec treatment**: Design in Phase 6, implementation "Phase 7 (post-hardening)"
**Assessment**: The spec now includes relay HA in Phase 6 as a design deliverable — this is the key improvement from Round 4. The architectural prescription (multi-region Fly.io + Redis Pub/Sub backplane) is correct and well-established. The remaining gap is that Phase 7 is undefined: no timeline, no capacity trigger, no rollout plan.
**Recommendation**: Add a capacity trigger: "When relay connections exceed 400 sustained (80% of single-instance practical capacity), relay HA Phase 7 becomes P0." Define Phase 7 as a concrete phase with scope (not an open-ended post-hardening item).
**Status**: PARTIALLY ADDRESSED (design added, implementation timeline absent)

### FINDING 2 — Neo4j Super-Node Mitigation (P1, previously identified)
**Scale trigger**: ~2,000+ agents (first super-nodes appear), degradation severe at 5,000+
**Spec treatment**: Phase 6 deliverable — pre-computed centrality scores for >500 degree nodes, materialized trust scores, per-target connection rate limiting
**Assessment**: The read-side mitigation is correct and now specified. The critical gap is write-side: MERGE lock contention on high-degree nodes during concurrent attestation writes. This is not mentioned in the spec.
**Recommendation**: Add write-side mitigation: batched relationship creation with debounce buffer (e.g., 5-second flush window for attestation writes), or relationship property indexing to reduce MERGE scan scope. Add this to Phase 6 deliverables.
**Status**: PARTIALLY ADDRESSED (read-side specified, write-side unaddressed)

### FINDING 3 — Offline Queue Replication Design (NEW — P1)
**Scale trigger**: Multi-instance relay deployment (~500+ agents, Phase 7)
**Spec treatment**: Not addressed
**Assessment**: The spec specifies offline queue behavior in detail (1,000 message cap, per-sender limits, priority delivery, queue-full behavior). All of this assumes a single relay instance owns the queue. With multi-instance deployment, the queue must be instance-independent (Redis-backed). The spec does not specify how the offline queue transitions to distributed storage when multi-instance is activated. This is a correctness issue, not just a performance issue — messages sent to an offline agent through relay-instance-A are invisible to the agent when it reconnects to relay-instance-B.
**Recommendation**: Add to Phase 6 relay HA design: specify that offline queue is migrated to Redis-backed store when multi-instance deployment activates. Define queue partitioning strategy (e.g., keyed by recipient fingerprint for consistent routing). This is a design requirement, not just an implementation detail.
**Status**: NOT ADDRESSED (new finding)

### FINDING 4 — IQS Cache Stampede (NEW — P2)
**Scale trigger**: ~1,000+ agents with synchronized registration timestamps
**Spec treatment**: 1-hour TTL specified, no stampede prevention
**Assessment**: Agents registered at the same time (e.g., during a launch cohort or viral signup wave) will have synchronized IQS cache expiry. When TTL expires simultaneously, all agents query MoltBridge for IQS refreshes within seconds of each other. At 1,000 agents, this is ~1,000 MoltBridge API queries in a short window. The circuit breaker (3 failures → disable enrichment for 5 minutes) would likely trip, leaving all agents in enrichment-disabled state for 5 minutes every hour.
**Recommendation**: Jitter cache TTL on write: `actual_ttl = base_ttl + random(0, base_ttl * 0.2)`. This distributes expiry across ±12 minutes around the 1-hour mark and prevents synchronized stampedes. Two-line fix.
**Status**: NOT ADDRESSED (new finding)

### FINDING 5 — PoW Queue Behavior Under Spike (P2)
**Scale trigger**: Attack spikes or viral registration events
**Spec treatment**: Dynamic difficulty ceiling (10x baseline) and fast-solver throttling specified; queue behavior unspecified
**Assessment**: The difficulty ceiling correctly prevents legitimate agents from being locked out. The missing piece is queue depth: how many PoW verifications can be in-flight simultaneously? Without a queue depth limit, a spike of 10,000 connection attempts creates a PoW verification backlog proportional to 10,000 × (compute time). The relay process is blocked on verification while legitimate agents wait. The spec should define max concurrent PoW verifications (e.g., CPU cores × 2) and queue-full behavior (reject with Retry-After rather than queue indefinitely).
**Recommendation**: Add to Section 3.12: define max concurrent PoW verification slots. Queue overflow drops new PoW submissions with HTTP 429 + Retry-After. This prevents memory exhaustion on spike.
**Status**: NOT ADDRESSED (new finding)

### FINDING 6 — MoltBridge Proof-of-AI Viral Saturation (P2)
**Scale trigger**: Viral registration spike (5,000+ in days)
**Spec treatment**: Error code `REGISTRATION_RATE_LIMITED` defined; behavior undefined
**Assessment**: The Proof-of-AI challenge is a per-registration requirement. If the PoA endpoint is rate-limited by MoltBridge's own infrastructure, new agents receive `REGISTRATION_RATE_LIMITED` with no specified retry behavior. Agents may retry immediately (thundering herd) or fail permanently (poor UX). Instar's Layer 3 capabilities are degraded until registration succeeds.
**Recommendation**: Specify retry behavior: exponential backoff with jitter (e.g., initial 30s, max 10 minutes, jitter ±20%). Add registration queue UX: "MoltBridge registration pending — Layer 3 discovery available once registration completes. Estimated wait: X minutes."
**Status**: NOT ADDRESSED (new finding)

### FINDING 7 — FTS5 Directory Serialization (P3)
**Scale trigger**: 200+ concurrent discovery queries
**Spec treatment**: Not mentioned
**Assessment**: SQLite with FTS5 is single-writer. Concurrent FTS5 queries on the Threadline relay directory serialize on read locks. Under normal load with well-distributed query timing, this is fine. Under coordinated discovery traffic (many agents simultaneously searching for the same popular capability), FTS5 queries queue up. At 500+ concurrent agents, this could add 50–200ms latency to relay discovery.
**Recommendation**: Move the FTS5 directory to a separate SQLite database from the relay message queue (separation of concerns prevents FTS5 locking from affecting message delivery). Consider caching FTS5 results for popular queries (5-minute TTL per query string) to reduce lock contention. Long-term: migrate FTS5 directory to a dedicated search service when relay scales to multi-instance.
**Status**: NOT ADDRESSED (low priority for current phase)

---

## Scorecard vs Round 4

| Issue | Round 4 Status | Round 5 Status |
|-------|---------------|----------------|
| Relay SPOF (single-instance ceiling) | OPEN (P1) | PARTIALLY ADDRESSED — design specified in Phase 6, implementation deferred to Phase 7 |
| Neo4j super-node read degradation | OPEN (P1) | ADDRESSED — >500 degree triggers pre-computed batch scores |
| Neo4j super-node write contention | NOT IDENTIFIED | OPEN (P1 new) — MERGE lock contention unaddressed |
| Queue-full behavior | OPEN (P1) | ADDRESSED — silent drop, priority replacement, 429 response |
| Queue priority ordering | OPEN (P1) | ADDRESSED — trusted/verified first, untrusted rate-limited on flush |
| Per-sender queue limits | OPEN (P1) | ADDRESSED — 10 messages per sender cap |
| PoW difficulty ceiling | OPEN (P1) | ADDRESSED — 10x baseline cap, fast-solver throttling |
| Per-target receive rate limiting | OPEN (P1) | ADDRESSED — 20 msg/hour from untrusted |
| Offline queue replication (multi-instance) | NOT IDENTIFIED | OPEN (P1 new) — no distributed queue design |
| IQS cache stampede | NOT IDENTIFIED | OPEN (P2 new) — TTL jitter absent |
| PoW queue depth / overflow | NOT IDENTIFIED | OPEN (P2 new) |
| MoltBridge PoA viral saturation | NOT IDENTIFIED | OPEN (P2 new) |
| FTS5 directory serialization | NOT IDENTIFIED | OPEN (P3 new) |

**Net progress**: 7 of 8 Round 4 P1 scalability items resolved. 1 P1 remains (relay HA implementation timeline). 2 new P1 items identified. 3 new P2 items. 1 new P3.

---

## Critical Issues

| # | Issue | Scale Trigger | Severity | Fix |
|---|-------|--------------|----------|-----|
| 1 | Relay HA implementation has no capacity trigger or Phase 7 scope | ~500 concurrent agents | P1 | Define capacity trigger (400 sustained connections → Phase 7 becomes P0) |
| 2 | Offline queue not designed for multi-instance relay | Phase 7 activation | P1 | Specify Redis-backed distributed queue in Phase 6 relay HA design |
| 3 | Neo4j MERGE write-lock contention on super-nodes | ~2,000 agents + attestation load | P1 | Batched write buffer with debounce; add to Phase 6 deliverables |
| 4 | IQS cache stampede from synchronized TTL expiry | ~1,000 agents | P2 | TTL jitter on write (two-line fix) |
| 5 | PoW queue depth unbounded under spike | Viral spike | P2 | Define max concurrent PoW slots + queue-full rejection |
| 6 | MoltBridge PoA viral saturation — retry behavior undefined | Viral registration wave | P2 | Specify exponential backoff + registration queue UX |

---

## Recommendations (Prioritized)

### P1 — Should Fix (Spec Updates)

| # | Recommendation | Effort | Impact | Phase |
|---|---------------|--------|--------|-------|
| 1 | Define capacity trigger for Phase 7 relay HA activation (400 sustained connections) | Low (spec text) | High | Phase 6 |
| 2 | Add distributed offline queue design to Phase 6 relay HA scope | Medium (design) | High | Phase 6 |
| 3 | Add write-side super-node mitigation to Phase 6 (batched attestation writes, debounce buffer) | Medium | High | Phase 6 |

### P2 — Should Fix (Low-Effort Wins)

| # | Recommendation | Effort | Impact | Phase |
|---|---------------|--------|--------|-------|
| 4 | IQS cache TTL jitter — `actual_ttl = base_ttl + random(0, base_ttl * 0.2)` | Trivial | Medium | Phase 4 |
| 5 | PoW verification queue depth limit + queue-full rejection (429 + Retry-After) | Low | Medium | Phase 3 |
| 6 | MoltBridge PoA retry behavior — exponential backoff spec + registration queue UX | Low | Medium | Phase 4 |

### P3 — Nice to Have

| # | Recommendation | Effort | Impact | Phase |
|---|---------------|--------|--------|-------|
| 7 | FTS5 directory in separate SQLite DB from relay message queue | Low | Low | Phase 3 |
| 8 | Popular query caching for FTS5 directory (5-min TTL per query string) | Low | Low | Phase 4 |
| 9 | Viral spike cost model — add infrastructure cost projections to business model section | Low | Medium | Business section |
| 10 | Neo4j write throughput profiling target (Neo4j AuraDB instance write limit awareness) | Low | Medium | Phase 6 |

---

## Scalability Assessment Summary

| Phase | Risk Level | Key Constraint | Spec Adequacy |
|-------|-----------|---------------|---------------|
| MVP (10–50) | LOW | None significant | Adequate |
| Growth (50–500) | MEDIUM | PoW queue depth at spikes; attestation write pattern established | Mostly adequate, minor gaps |
| Scale (500–5,000) | MEDIUM-HIGH | Relay HA implementation timing; offline queue replication; super-node write contention; IQS stampede | Spec improved but 3 gaps remain |
| Viral (5,000+ in days) | HIGH | All above simultaneously; PoA saturation; cost cliff; PoW queue exhaustion | Inadequate — no capacity plan for viral scenario |

---

## Observations

**What v0.4.0 Gets Right (That v0.3.0 Didn't)**

The Round 4 scalability review's P1 items are now substantially addressed. The queue behavior section (Section 3.12) is notably more complete — queue-full semantics, per-sender limits, and priority ordering are all specified with enough precision to implement. The PoW ceiling addition (10x baseline, fast-solver throttling) directly solves the resources-as-weapon problem. The relay HA design requirement in Phase 6 means the architecture decision is at least captured before production deployment. The spec's local-first design continues to be its biggest scalability asset: most agent interactions never touch the relay or MoltBridge, so the load surface is smaller than it appears.

**The Deferral Pattern Is Both a Strength and a Risk**

The spec consistently defers scaling complexity to later phases, which is architecturally sound (don't optimize prematurely) but creates operational risk if phases slip or user growth outpaces the implementation timeline. The relay HA case is the clearest example: correct architectural approach, correct phase placement for design, but no defined trigger for when implementation becomes mandatory. The system will function correctly until it doesn't, and the transition from functioning to failing is abrupt (relay SPOF → outage) rather than gradual.

**Cost Model Is Underdeveloped for Scale**

The spec's business model section (Section 7) states relay costs as "~$20/month at MVP scale." This is accurate. It does not model growth or scale phases. At 2,000 agents with multi-instance relay + Redis backplane + Neo4j AuraDB Professional, costs are $300–600/month. At 5,000 agents, $600–1,200/month. Break-even at "~500 active agents at current fee structure" is likely correct for MVP, but the cost curve steepens faster than the revenue curve at scale (discovery fees are pay-per-use, not subscription). A cost scaling model would reveal whether the economics work at Phase 5+.

---

## Score Rationale

**8.2/10** (up from 7.5/10 in Round 4)

- +0.5 for resolving all 7 Round 4 P1 queue behavior items
- +0.2 for adding relay HA design as Phase 6 deliverable
- +0.2 for neo4j super-node read mitigation being specified
- +0.2 for PoW difficulty ceiling addition
- -0.3 for relay HA implementation timeline absent (Phase 7 undefined)
- -0.2 for offline queue replication design missing (multi-instance correctness gap)
- -0.2 for neo4j write-side contention unaddressed

The 3 new P1 gaps are genuine improvements in review thoroughness, not regressions in the spec. The spec's actual scalability posture has improved materially. The remaining issues are solvable with targeted spec additions without architectural changes.

---

## Approval Conditions

1. **Before Phase 6**: Add capacity trigger for relay HA Phase 7 activation. Define distributed offline queue design (Redis-backed) in Phase 6 scope.
2. **Before Phase 6**: Add neo4j write-side super-node mitigation (batched write buffer) to Phase 6 deliverables.
3. **Before Phase 4**: Add TTL jitter to IQS cache specification. Add PoA retry behavior (exponential backoff). Add PoW queue depth limit.

None of these require architectural changes. They are spec clarifications and targeted additions. If addressed, this review upgrades to APPROVE.

---

*Generated by SpecReview scalability reviewer, Round 5. 2026-03-29.*

*Research sources: [Neo4j Super Node Performance](https://jboylantoomey.com/post/neo4j-super-node-performance-issues) | [Graph Modeling Super Nodes](https://medium.com/neo4j/graph-modeling-all-about-super-nodes-d6ad7e11015b) | [Scaling Pub/Sub with WebSockets and Redis](https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis) | [WebSockets at Scale](https://websocket.org/guides/websockets-at-scale/) | [Fly.io Concurrency Guidelines](https://fly.io/docs/apps/concurrency/) | [Redis WebSocket Scaling](https://leapcell.io/blog/scaling-websocket-services-with-redis-pub-sub-in-node-js) | [Neo4j Performance Guide](https://medium.com/@satanialish/the-production-ready-neo4j-guide-performance-tuning-and-best-practices-15b78a5fe229)*

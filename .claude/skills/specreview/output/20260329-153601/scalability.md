# Scalability Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-153601
**Reviewer**: Scalability & Infrastructure
**Round**: 4
**Date**: 2026-03-29

---

### Approval Status: CONDITIONAL APPROVAL

### Score: 7.5/10

**Justification**: The architecture is sound for Phases 0-3 (prototype through founding cohort). Five scaling concerns surface at Phase 4+ that need design decisions now even if implementation is deferred. The single-instance relay and Neo4j super-node problem are the most consequential.

---

### Research Findings

1. **Neo4j at Scale**: Handles 12M+ nodes in production but super-nodes and write serialization through the Raft leader are real bottlenecks. Popular nodes with 10K+ relationships cause graph traversal slowdowns from milliseconds to seconds.

2. **Base L2 Performance**: $0.0016/tx and 2,000 TPS — the payment layer is not the bottleneck. Well-chosen for micropayments.

3. **Fly.io WebSocket Scaling**: Configurable limits up to ~25K connections per instance, but auto-scaling is unreliable for WebSocket-only apps. Connection count doesn't trigger auto-scaling the same way HTTP request rate does.

4. **Distributed Trust Collusion**: Documented problem in reputation systems. The spec's cross-verification weighting (0.58) is the right defense but "anomaly detection" on the graph side needs more specificity.

---

### Critical Issues (must fix before building)

**C1 (HIGH) — Single-instance relay is a hard ceiling** (Section 3.4, Open Question #6)

Fly.io auto-scaling doesn't reliably trigger on WebSocket connection count. Without a Redis Pub/Sub backplane, the relay hits a hard connection ceiling (~500–2,000 concurrent agents) with no graceful degradation. The spec defers federation to future work — this needs a timeline before adoption pressure forces it.

**Suggested fix**: Add relay HA (multi-region + Redis Pub/Sub) as a Phase 6 deliverable. Define connection backpressure for the interim: priority queue for `verified`+ agents, graceful rejection with retry-after for new connections at capacity.

**C2 (HIGH) — Neo4j super-node problem at 1,000+ agents** (Section 3.8, 3.9)

Popular agents (heavy attestation volume, frequent broker introductions) accumulate thousands of relationships. The trust scoring formula (0.58× cross-verification) traverses exactly these high-degree nodes. Query times degrade from milliseconds to seconds at 10K relationships per node.

**Suggested fix**: Pre-computed centrality scores for high-degree nodes (batch job, not per-query). Degree threshold (e.g., 500 relationships) triggers materialized trust score rather than live traversal. Add to Phase 4 deliverables.

---

### Recommendations (should fix, not blocking)

**C3 (MEDIUM) — Key rotation broadcast has no delivery guarantee** (Section 3.10)

Rotation messages are fire-and-forget via relay. No acknowledgment, no retry, no durability guarantee. A peer who misses the broadcast during relay downtime continues accepting messages from a potentially compromised key.

**Suggested fix**: Rotation events should be durable relay events with 72h retention (matching the revocation grace period). Add pull-based revocation check: before granting new permissions, verify the peer's key against their Agent Card or MoltBridge record.

**C4 (MEDIUM) — Offline queue exhaustion** (Section 4.2)

1,000 message cap with 7-day TTL means a sender at 1 msg/min exhausts a recipient's queue in ~17 hours. Queue-full behavior is unspecified (silent drop? error to sender? oldest eviction?).

**Suggested fix**: Define queue-full behavior (recommend oldest-eviction with sender notification). Consider per-sender queue slots to prevent one active sender from monopolizing another agent's offline queue.

**C5 (LOW-MEDIUM) — PoW dynamic difficulty creates two-tier access** (Section 3.12)

Resource-constrained agents (Raspberry Pi, edge hardware) may face minutes-long PoW during attack-triggered difficulty spikes, effectively excluding them when the network most needs to remain open.

**Suggested fix**: Cap maximum PoW difficulty at ~10s on the lowest target hardware class. Offer alternative proof for known agents: relay-issued reconnection tokens (cookie-based, already partially specified).

---

### Observations

- Base L2 at $0.0016/tx is well below pain threshold. Payment layer won't be a bottleneck.
- The 1-hour IQS cache TTL is appropriate for Phase 4. May need reduction to 15-30min at scale if trust scores change frequently.
- Discovery waterfall timeouts (5s relay, 15s network) are reasonable but should be configurable.
- Attestation write volume at scale could create Neo4j write amplification in Phase 5 — monitor closely.

---

### Scalability Assessment

| Phase | Users/Agents | Key Bottleneck | Risk Level |
|-------|-------------|----------------|------------|
| MVP (0-3) | 10-50 | None significant | LOW |
| Growth (Phase 4) | 50-500 | Relay connection limit, MoltBridge API rate limits | MEDIUM |
| Scale (Phase 5) | 500-5,000 | Neo4j super-nodes, relay SPOF, attestation write volume | HIGH |
| Viral spike | 5,000+ in days | All of the above simultaneously | HIGH |

- **Phases 0–3**: LOW risk — prototype/founding cohort scale is fine
- **Phase 4 (MoltBridge)**: HIGH risk — first hard ceilings surface (relay capacity, Neo4j super-nodes, MoltBridge API rate limits unspecified)
- **Phase 5 (Bridge)**: HIGH risk — attestation write volume creates Neo4j write amplification
- **Phase 6 (Observability)**: MEDIUM risk — Prometheus cardinality needs constraints (label explosion from per-agent metrics)

---

*Generated by SpecReview Scalability Reviewer, Round 4.*

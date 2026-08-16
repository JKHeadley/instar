# Scalability Review: Cross-Topic Injection Defense

**Spec**: `specs/cross-topic-injection-defense.md`
**Reviewer**: Scalability & Infrastructure Specialist
**Review ID**: 20260309-180602
**Round**: 1

---

## Approval Status

**CONDITIONAL APPROVAL** -- The design is sound for current scale (single-agent, <50 sessions, <100 messages/day). It will hit meaningful bottlenecks at 10x-100x scale without the modifications recommended below.

---

## Score: 7/10

Strong architectural instincts (layered defense, fail-open, deterministic fast path), but several scalability gaps that would become painful at moderate growth.

---

## Research Findings

### Haiku API Latency and Rate Limits
- **Claude Haiku 4.5**: ~639ms time-to-first-token (TTFT), ~952ms total latency for short completions. This is current March 2026 benchmark data.
- **Pricing**: $1/M input tokens, $5/M output tokens. With prompt caching, input drops to $0.10/M for cache hits.
- **Rate limits**: Haiku has the highest rate limits among Claude models, but exact RPM/TPM vary by tier. Tier 1 accounts typically get 50 RPM; Tier 4 can reach 4000 RPM.
- **Implication for this spec**: The spec estimates <5 Haiku calls/day. At that volume, latency and rate limits are irrelevant. But if the system scales to multi-user or multi-agent, these numbers matter (see below).

### LLM-Based Input Validation at Scale
- Industry best practice for LLM-as-judge validation: sample 1-10% of traffic, not 100%.
- Validation doubles the LLM call count per request when applied universally.
- Smaller/faster models (like Haiku) are the correct choice for validation tasks.
- Batching multiple validation requests into a single prompt is a known cost-reduction technique.
- **Implication**: The spec's approach of only validating untagged messages to topic-bound sessions is a correct narrowing of scope. The question is whether "untagged" remains rare at scale.

### SQLite Topic Memory Performance
- SQLite handles 100K+ reads/sec on modest hardware, with reports of 4M QPS on optimized configurations.
- Single-writer model limits writes to ~50K/sec.
- Databases with 40M+ rows perform well with proper indexing.
- **Implication**: `TopicMemory.getRecentMessages(topicId, 5)` is a trivially fast query even at 1000x current scale. SQLite is not the bottleneck here.

### tmux Session Management Overhead
- Per-session overhead is small (memory for PTY, window state) but additive.
- With many sessions (50+), aggregate RAM and file handle consumption becomes significant.
- Each tmux `send-keys` call is a subprocess invocation, adding ~5-10ms per injection.
- **Implication**: At current scale (5-15 sessions), tmux is fine. At 100+ sessions (multi-agent or multi-user), tmux becomes a coordination bottleneck, especially for the synchronous `injectMessage` path this spec modifies.

---

## Critical Issues

### 1. Synchronous LLM Call in the Message Injection Hot Path (SEVERITY: HIGH)

The spec adds an async Haiku call (~1s latency) inside `injectMessage`, which is the critical path for delivering messages to sessions. Even with the "fail-open on timeout" design, this introduces:

- **Head-of-line blocking**: If 10 untagged messages arrive simultaneously (e.g., user typing rapidly in dashboard), each waits ~1s for coherence review sequentially. The 5-second rate limiter makes this worse -- only 1 review per 5 seconds means a burst of 5 messages takes 25 seconds.
- **At 10x scale** (50 sessions, multiple users): The Haiku call becomes a serialization point. If even 10% of messages are untagged, you're making 10-50 LLM calls per hour in the injection path.
- **At 100x scale**: This becomes untenable without architectural change.

**Recommendation**: Decouple the coherence review from the injection path. Inject the message immediately with a lightweight structural warning ("provenance unknown"), then run the Haiku review asynchronously. If the review returns SUSPICIOUS, inject a follow-up warning into the session. This eliminates the latency penalty entirely.

### 2. Rate Limiter Design Creates Silent Drops (SEVERITY: HIGH)

The spec states: "max 1 LLM call per 5 seconds. Messages arriving within the window get queued or pass-through (fail-open within burst)." The "or" here is ambiguous and dangerous:

- **If queued**: Messages are delayed, which violates constraint #2 ("must not add latency to the happy path").
- **If pass-through**: During a burst of injected messages (the exact attack scenario), only the first one gets reviewed. The rest pass through unchecked. An attacker who sends 5 messages in 5 seconds gets 4 of them through unreviewed.
- **At scale**: Bursts become more common, making the rate limiter's fail-open behavior a systematic bypass.

**Recommendation**: Use a token bucket rate limiter (e.g., 10 tokens, refill 2/sec) instead of a fixed 1-per-5s window. This handles bursts while still capping sustained load. Alternatively, batch multiple messages into a single coherence review call.

### 3. No Backpressure or Circuit Breaker for Haiku API (SEVERITY: MEDIUM)

The spec mentions a 3-second timeout but no circuit breaker. If the Haiku API is degraded (elevated latency, partial outages), every untagged message will wait the full 3 seconds before timing out. At scale:

- **10 untagged messages during an API outage**: 30 seconds of aggregate delay in the injection path.
- **No circuit breaker**: The system keeps hammering a degraded API instead of switching to fail-open mode after N consecutive failures.

**Recommendation**: Add a circuit breaker that trips after 3 consecutive failures/timeouts. When tripped, skip coherence review for 60 seconds (fail-open with logging). This prevents cascading latency during API outages.

---

## Recommendations

### R1. Async Review Architecture (Priority: HIGH)

Restructure the flow to inject first, review second:

```
Message arrives → Provenance check (deterministic, <1ms)
  → PASS: inject immediately
  → MISMATCHED: block immediately
  → UNTAGGED: inject with "[provenance: unverified]" marker
              → async: run Haiku review
              → if SUSPICIOUS: inject follow-up warning into session
```

This eliminates ALL latency from the injection path while preserving the security benefit. The session receives the message and potentially a warning 1-2 seconds later. The LLM context window sees both.

### R2. Cost Projection and Budget Caps (Priority: MEDIUM)

The spec estimates <5 Haiku calls/day but provides no cost cap or budget mechanism. At current pricing:

| Scale | Untagged msgs/day | Haiku calls/day | Monthly cost |
|-------|-------------------|-----------------|-------------|
| Current (1 agent) | ~5 | ~5 | ~$0.03 |
| 10x (10 agents) | ~50 | ~50 | ~$0.30 |
| 100x (100 agents, multi-user) | ~500 | ~500 | ~$3.00 |
| Viral spike (1000 agents) | ~5000 | ~5000 | ~$30.00 |

These costs are trivial. However, the cost model assumes untagged messages remain rare. If a new input channel is added that doesn't tag messages, or if dashboard usage increases, the ratio flips. A budget cap (e.g., max 100 Haiku calls/day, then fail-open) provides a safety net.

### R3. Security Audit Log Rotation (Priority: MEDIUM)

All provenance decisions are logged to `.instar/security.jsonl`. This is an append-only file with no rotation policy mentioned. At scale:

- 100 messages/day = ~10KB/day = ~3.6MB/year (manageable)
- 10,000 messages/day = ~1MB/day = ~365MB/year (needs rotation)
- The `messagePreview` field in each log entry could contain large messages

**Recommendation**: Add log rotation (e.g., rotate at 10MB, keep last 5 files) or integrate with the existing skip-ledger for deduplication awareness.

### R4. Dashboard Input Allowlisting Should Be Phase 1, Not Phase 3 (Priority: MEDIUM)

The spec defers dashboard allowlisting to Phase 3. But dashboard input is the primary source of legitimate untagged messages. Without Phase 3, every dashboard keystroke to a topic-bound session triggers a Haiku call. This means:

- Phase 1+2 without Phase 3 = every dashboard interaction is penalized with ~1s latency
- Users will notice and complain before Phase 3 ships
- This could block adoption of the entire feature

**Recommendation**: Move dashboard allowlisting to Phase 1 or make it concurrent with Phase 2. At minimum, add a heuristic: if the instar server itself is the source of the `send-keys` call (which it is for Telegram/WhatsApp relay), mark it as "relay-sourced." Only truly external `send-keys` calls (direct tmux access) need review.

### R5. Multi-Topic Binding (Priority: LOW, but design now)

The spec acknowledges "Multiple valid topics (e.g., merged thread) — Not supported yet." At scale, topic merging and cross-referencing become common. The current single-binding model means:

- A session discussing topics 116 AND 117 would block messages from topic 117
- No mechanism to "widen" a session's scope mid-conversation

**Recommendation**: Design the binding data structure as an array from the start (`INSTAR_BOUND_TOPICS=116,117`), even if Phase 1 only supports a single entry. This avoids a breaking migration later.

---

## Observations

### O1. The "Warn, Don't Block" Default Is Correct for Scale

The spec's default action mode (`"warn"`) is the right choice. Blocking creates support burden (false positives require manual intervention). Warning lets the LLM self-correct, which scales without human involvement. The "block" mode should be reserved for high-security deployments where false positives are acceptable.

### O2. The Provenance Check Is Elegant and Free

Layer 1 (deterministic tag matching) is zero-cost, zero-latency, and catches the most common failure mode (routing errors). This is textbook defense-in-depth: the cheap layer handles 95% of cases, the expensive layer handles the remaining 5%.

### O3. Environment Variables for Binding Are Fragile at Scale

Using `INSTAR_BOUND_TOPIC` environment variables means binding is set at session spawn time and cannot change. If a session is reassigned to a different topic (which the topic-session registry supports), the env vars are stale. At scale, session reassignment becomes more common.

**Consider**: Reading the binding from the topic-session registry at check time (a local file/SQLite read) rather than relying on env vars. This adds ~1ms but ensures binding is always current.

### O4. The Spec Correctly Identifies Its Own Limitations

The "What This Does NOT Catch" section is honest about topic-matching injections, unbound sessions, and legitimate user misbehavior. This is good engineering -- the spec doesn't overclaim. However, at scale, these gaps become attack surfaces. Topic-matching injections in particular become more likely as an attacker can observe what topics a session handles.

### O5. No Metrics or Observability

The spec logs to `security.jsonl` but doesn't mention metrics (counters, histograms, dashboards). At scale, you need to answer: "How many messages are being reviewed? What's the false positive rate? What's the average review latency?" Without these, you're flying blind on whether the feature is helping or hurting.

**Recommendation**: Add counters for: total messages, messages by provenance result (pass/block/review), review results (coherent/suspicious), review latency (p50/p99). These can be lightweight in-memory counters exposed via the `/status` endpoint.

---

## Scalability Assessment

| Dimension | Current Scale | 10x | 100x | 1000x | Verdict |
|-----------|--------------|-----|------|-------|---------|
| **Database (SQLite topic memory)** | Trivial | Fine | Fine | Fine | SQLite handles this effortlessly. Not a concern at any realistic scale. |
| **API/Network (Haiku calls)** | ~5/day, negligible | ~50/day, fine | ~500/day, watch rate limits | ~5000/day, need tier upgrade | Scales linearly with untagged messages. Cost is trivial; rate limits are the real constraint at 1000x. |
| **Compute (coherence review in injection path)** | Imperceptible | Noticeable if bursty | Head-of-line blocking risk | Untenable without async redesign | The synchronous design is the primary scalability bottleneck. |
| **Cost** | ~$0.03/mo | ~$0.30/mo | ~$3/mo | ~$30/mo | Cost is not a meaningful concern. Haiku is cheap enough that even aggressive scaling is affordable. |
| **Viral Spike Handling** | N/A | N/A | Rate limiter becomes bypass vector | System degrades gracefully (fail-open) but security degrades too | The rate limiter needs redesign for burst resilience. |
| **Data Model (single topic binding)** | Sufficient | Sufficient | Limiting | Breaking | Multi-topic binding should be designed in now, even if not implemented. |
| **tmux overhead** | Negligible | Manageable | Significant | Architectural limit | Not this spec's problem, but the synchronous injection path amplifies tmux's per-call overhead. |

### Overall Scalability Verdict

The design scales well to **10x** current load with no changes. At **100x**, the synchronous Haiku call in the injection path and the simplistic rate limiter become real problems. At **1000x**, an architectural shift to async review is mandatory. The good news: the layered design makes this migration straightforward -- Layer 1 (deterministic) carries 95%+ of the load at any scale, and only the Layer 2 path needs restructuring.

---

*Review generated by scalability specialist, round 1.*

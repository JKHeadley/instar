# Scalability Review: Coherence Gate — Round 2

**Review ID**: 20260309-131232
**Reviewer**: Scalability
**Round**: 2 (prior: 20260309-122235)
**Date**: 2026-03-09

## Approval Status: APPROVE

---

## Improvements Since Round 1

1. **Cost model corrected** (was conflict) — NOW ADDRESSED. Output tokens at $5/MTok properly included. New estimate: ~$0.005/review without caching, ~$0.003 with caching, ~$3-6/month at 100 responses/day. This aligns with my Round 1 correction.

2. **Prompt caching designed in from day one** (was P1) — NOW ADDRESSED. `promptCaching: true` in config. Cached tokens don't count toward ITPM rate limits, effectively doubling throughput headroom. Spec correctly notes 90% savings on ~60% of input tokens.

3. **`Promise.allSettled`** (was unique finding) — NOW ADDRESSED. Spec explicitly calls out `Promise.allSettled` for parallel reviewer execution. Single reviewer timeout doesn't reject the batch.

4. **Rate limit header awareness** (was unique finding) — NOW ADDRESSED. Section on Reviewer Consolidation at Scale mentions reading `anthropic-ratelimit-requests-remaining` from API response headers for tiered execution.

5. **Conditional execution** — NEW. Only running URL Validity when URLs are present, Settling Detection when negative results are mentioned. Reduces average parallel calls from 7 to 3-4.

---

## Research Findings

- **Anthropic pricing (March 2026)**: Haiku 4.5 at $1/$5 input/output per MTok. Prompt cache reads at $0.10/MTok (10x cheaper). Cache write at $1.25/MTok for 5-minute TTL. The spec's cost numbers are now accurate.
- **Cache behavior**: Cached tokens genuinely don't count toward ITPM rate limits. With 80% cache hit rate, effective throughput is 5x the nominal ITPM limit. This is the single most important scaling lever.
- **Workspace-level cache isolation** (Feb 2026 change): Caches are now workspace-scoped, not org-scoped. This means agents on different workspaces can't share cached prompts. For fleet deployments, keeping all agents on the same workspace maximizes cache hit rates.

---

## Critical Issues (must fix before building)

None. All Round 1 critical scaling issues have been addressed.

---

## Recommendations (should fix, not blocking)

### 1. Cache Warming Strategy (MEDIUM)
**Section**: Cost Analysis, Implementation Plan

The spec mentions prompt caching but doesn't address cold start. After server restart, the first review for each reviewer misses the cache. With 7 reviewers, that's 7 uncached calls at full price and without rate limit benefits.

**Suggestion**: Add a warm-up call at server start — send a dummy message through each reviewer to prime the cache. Cost: ~$0.003 one-time at startup. Benefit: first real review gets full cache benefits.

### 2. Workspace Alignment for Fleet (LOW)
**Section**: Reviewer Consolidation at Scale

The Feb 2026 change to workspace-level cache isolation means fleet deployments should co-locate agents on the same Anthropic workspace to maximize cache sharing. The spec doesn't mention this.

**Suggestion**: Document as a fleet deployment recommendation.

### 3. Complaint Classifier Cost Tracking (MEDIUM)
**Section**: Organic Evolution — Complaint Detection

The complaint classifier runs a Haiku call on every incoming user message. This is a new cost center not included in the cost analysis. At 100 messages/day, it adds ~$0.01-0.02/day (trivial), but it's an unbounded cost that scales with inbound message volume, not just outbound response volume.

**Suggestion**: Add to the cost analysis section. Consider a local pre-filter (regex for complaint keywords) to reduce classifier calls.

### 4. Thematic Consolidation Threshold (LOW)
**Section**: Reviewer Consolidation at Scale

The spec describes three consolidation strategies (tiered, thematic, conditional) but doesn't specify when to switch. At what RPM headroom do you move from full parallel to tiered? At what point does thematic consolidation activate?

**Suggestion**: Define thresholds. E.g., "When `anthropic-ratelimit-requests-remaining` drops below 20% of the limit, switch to tiered execution (top 3 reviewers only)."

---

## Observations

1. The `skipGate` optimization for external channels is a cost increase (every external message gets full review) but the right call for quality. The cost impact is bounded: external messages are typically <30% of total volume.

2. The queue-and-hold mechanism for fail-closed channels introduces a memory concern. If the queue grows (e.g., API outage during a burst of Telegram messages), the server needs to bound queue size. Not specified.

3. The canary testing (every 6 hours) is negligible cost — 3 test messages × full pipeline = ~$0.015/day.

4. The local self-patching (reviewer prompt augmentation from `.instar/state/reviewer-patches/`) increases input tokens per reviewer over time as patches accumulate. This could erode cache benefits if patches differ significantly from the base prompt. Consider capping patch size or periodically consolidating patches into the base prompt.

---

## Scalability Assessment

| Phase | Assessment | Key Risks |
|-------|-----------|-----------|
| 1-10 agents | GREEN | None. ~$3-6/month/agent. Cache warming optional. |
| 10-50 agents | GREEN | Ensure workspace alignment for cache sharing. ~$30-300/month total. |
| 50-100 agents | GREEN-YELLOW | Prompt caching handles the load. Monitor RPM headroom. ~$150-600/month. |
| 100-500 agents | YELLOW | Activate conditional execution (3-4 reviewers avg vs 7). Read rate limit headers. ~$300-3K/month. |
| 500-1,000 agents | ORANGE | Tiered execution required. Consider Tier 4 API. Contact Anthropic for custom limits. ~$1.5-6K/month. |
| 1,000+ agents | RED | Thematic consolidation (2-3 calls instead of 7). Multi-workspace strategy. ~$3-6K+/month. |
| Viral spike (100 agents in 1 hour) | YELLOW | Queue-and-hold absorbs burst for external channels. Fail-open for internal. Cache warm-up needed for new agents. |

**Latency remains the primary bottleneck, not cost.** Full review is 2-4s. With revision, worst case is ~18s. The spec's UX mitigations (typing indicators, SSE events) are the right approach but should be validated empirically.

---

## Score: 8/10

**Justification**: Major improvement from Round 1 (was 7/10). Cost model is now accurate. Prompt caching is designed in. Rate limit awareness is specified. Conditional execution reduces average load. The consolidation strategies provide a clear scaling path through 1,000+ agents. Remaining items (cache warming, workspace alignment, complaint classifier cost) are all low-priority optimizations, not structural concerns. This is a scalable architecture.

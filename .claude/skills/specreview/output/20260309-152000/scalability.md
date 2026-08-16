# Scalability Review: Coherence Gate — Round 3

**Reviewer**: Scalability & Infrastructure Specialist
**Spec**: specs/response-review-pipeline.md
**Round**: 3 (prior: Round 2 score 8.0/10)
**Focus**: Round 2 P1 resolution + new additions

---

## Approval Status: APPROVE

## Score: 8.5/10 (+0.5 from Round 2)

---

## Round 2 P1 Resolution

### P1: Per-Reviewer Model Config — RESOLVED
`reviewerModelOverrides` (line 265-267) allows per-reviewer model selection. Cost implications are documented: Sonnet ~5x Haiku. This is a scaling concern only if many reviewers are configured for Sonnet, but the default (Haiku for all, Sonnet only for high-stakes) is cost-appropriate.

**Cost impact at scale**: With 2 reviewers on Sonnet (Value Alignment, Claim Provenance) and 5 on Haiku:
- Per full review: ~$0.003 (Haiku) + ~$0.004 (2 Sonnet calls) = ~$0.007
- With gate optimization (60-70% skip): ~$0.002-0.003 average
- At 100 responses/day: ~$0.20-0.30/day, ~$6-9/month per agent
- Still well within the "negligible operational cost" range

---

## Assessment of New Additions

### Policy Enforcement Layer (PEL) — Negligible Cost
PEL runs deterministic regex checks in <5ms. Zero API cost. No scaling concern. If anything, PEL reduces costs by blocking obvious violations before LLM review runs.

### Semantic Evasion Detection — Minimal Cost
One embedding call per revision (~$0.0001). Only runs on revisions (estimated 5-15% of reviewed messages). At 100 responses/day with 10% revision rate: 10 embedding calls/day = ~$0.001/day. Negligible.

### Context Window Management — Smart Optimization
The collapse format for retry feedback (lines 908-918) keeps context window growth linear (~50 tokens per revision) rather than multiplicative. This prevents both quality degradation and increased generation cost during revision loops. Well-designed.

### Per-Recipient Review History — Storage Consideration
Review history now includes `recipientId` (line 1339, 1751-1752). This enriches the audit log but increases storage per review entry. At 30-day retention with content purging to metadata-only archive, this is manageable. The per-recipient breakdown in stats (line 1347) is a useful operational tool.

### Failure Mode Differentiation — Correct for Scale
The 6 failure classes (lines 811-824) handle degradation correctly:
- Partial reviewer outage: continue with available reviewers (graceful degradation)
- >50% reviewer timeout: escalate to infrastructure outage handling
- Queue-on-failure with bounded timeouts prevents unbounded resource consumption

**Note**: The queue size bounding recommendation from Round 2 (`maxQueueSize` per channel) is not explicitly in the spec but is implied by the timeout mechanism. During extended outages, queued messages time out and are delivered with warnings, preventing unbounded growth. This is sufficient.

---

## Phase Assessment

| Phase | Assessment | Key Consideration |
|-------|-----------|-------------------|
| **MVP** (1-10 agents) | GREEN | ~$6-9/month with Sonnet overrides. PEL at zero cost. |
| **Growth** (10-100 agents) | GREEN | Prompt caching reduces costs 40-50%. Workspace alignment for cache sharing. |
| **Scale** (100-1K agents) | GREEN | Tiered execution under rate pressure. Conditional reviewer execution reduces average parallel calls from 7 to 3-4. |
| **Enterprise** (1K+) | GREEN-YELLOW | Fleet cost at $6-9K/month for 1K agents with Sonnet overrides. Thematic consolidation (combine 7→2-3 calls) could reduce to $3-5K/month. |

### Cache Warming — Still Recommended
Round 2 recommendation for cache warming at server start is still valid. First review after restart misses cache (~$0.003 one-time cost). Low effort, low impact, but clean.

### Workspace Alignment — Still Recommended
Anthropic's workspace-level cache isolation means fleet deployments benefit from co-locating agents on the same workspace. Document as fleet recommendation.

---

## Latency Analysis

The spec's latency estimates are realistic:
- PEL: <5ms (regex, no network)
- Gate only: ~0.5-1s (one Haiku call)
- Full review (Haiku only): ~2-3s (parallel via Promise.allSettled)
- Full review (with Sonnet overrides): ~3-5s (Sonnet is slower than Haiku; the 2 Sonnet reviewers become the bottleneck in Promise.allSettled)
- Worst-case revision cycle: ~18-22s (with Sonnet, slightly longer)

The Sonnet bottleneck in Promise.allSettled is the main latency concern. Since all reviewers run in parallel, total latency = max(individual latencies). Sonnet calls typically take 2-5s vs Haiku's 0.5-1.5s.

**Mitigation**: The spec correctly notes typing indicators and SSE events bridge the UX gap. For the 60-70% of messages that skip full review via the gate, latency is unchanged.

---

## Summary

The spec scales cleanly at all projected phases. The new additions (PEL, semantic evasion, per-reviewer model overrides) add minimal cost. The biggest scaling factor is Sonnet usage for high-stakes reviewers, which roughly doubles per-review cost but remains well under $10/month per agent. Context window management during retries is a smart optimization that prevents cascading cost increases.

No blocking concerns. Ready for implementation.

# Scalability Review: Consent & Discovery Framework

**Review ID:** 20260321-232155
**Round:** 1
**Spec:** `specs/consent-discovery-framework.md`
**Reviewer Role:** Scalability & Infrastructure Specialist
**Date:** 2026-03-21

---

## Approval Status

**CONDITIONAL APPROVE** — The design is sound for the current scale (single-user, single-agent). It has 2-3 architectural decisions that will cause real pain at 10x-100x scale but none are fatal to the current phase. The LLM evaluator cost model is the highest-risk item and needs a concrete ceiling before Phase 3 ships.

---

## Scalability Score: 6 / 10

Solid for MVP. Below average for production multi-agent/multi-user deployment without the changes listed below.

---

## Research Findings

### Feature Flag Systems at Scale

Production feature flag systems (LaunchDarkly, Statsig, Unleash) face predictable failure modes as they grow:

- **Payload bloat:** As the feature registry grows, evaluation payloads grow with it. Statsig reports customers evaluating **billions of flags per day** — achieved only through aggressive client-side caching and streaming delta updates, not per-request server evaluation. The spec's `POST /features/evaluate-context` endpoint sends the entire `eligibleFeatures` catalog on every call; at 50+ features this becomes a fat prompt.
- **User-targeting inefficiency:** Targeting rules based on per-user IDs degrade at scale. The spec's per-user discovery state stored in `.instar/state/discovery/` will face lookup latency as the user population grows in multi-user deployments.
- **Cost cliff at ~100K MAU:** LaunchDarkly becomes prohibitively expensive around 100K monthly active users. The analogy here is: if instar grows to multi-tenant SaaS with many agents, the LLM evaluation cost follows a similar cliff.

### JSONL File Storage Performance

JSONL append operations are fast (~0.04ms per record, ~25x faster than JSON rewrite). For the discovery event log this is fine. However:

- **JSONL has no query capability.** Finding all events for a specific `featureId` requires a full file scan. At 90 days of retention with active multi-user agents, this file could reach tens of thousands of records. Cooldown queries ("when was this feature last surfaced?") will degrade from O(1) to O(n).
- **The spec's state files in `.instar/state/discovery/` are not JSONL** — they appear to be individual files per feature/user. File system directory listing at scale (hundreds of features × hundreds of users) becomes a bottleneck. SQLite — which instar already uses for `topic-memory.db` and `semantic.db` — handles this pattern far better: indexed queries, concurrent reads, WAL mode for write concurrency.

### LLM Evaluation Costs at Scale

Claude Haiku 4.5 pricing as of March 2026: **$1.00 input / $5.00 output per million tokens**. Batch API: $0.50/$2.50.

A discovery evaluation prompt including `DiscoveryContext` (userMessage + conversationTopic + eligibleFeatures catalog + autonomy profile) will realistically be **500–2000 input tokens** depending on feature count and conversation length. Output is small (~200 tokens).

Cost math:
- Single evaluation: ~0.001–0.002 USD at standard pricing
- 1 agent, 5 sessions/day, 2 evaluations/session: ~$0.02/day = **$7/year** — negligible
- 100 agents, same pattern: **$700/year** — manageable
- 1000 agents, same pattern: **$7,000/year** — noticeable
- 10,000 agents: **$70,000/year** — this is a real line item

The spec says "negligible" — this is true for single-agent use. It stops being true somewhere between 1,000-10,000 agents if instar goes multi-tenant. The design needs a cost ceiling defined now even if not enforced today.

### Consent Management at Scale

Enterprise CMPs (Didomi, Usercentrics) process 2+ billion consent signals monthly. They achieve this through:
1. Event sourcing (append-only log, exactly what this spec does — good)
2. Materialized read models (current state per user/feature as a fast lookup — the spec does NOT have this explicitly)
3. CDN-edge evaluation (not relevant here, but the pattern matters: push state to the edges, don't centralize lookups)

The spec conflates the event log (source of truth) with the current state (derived, fast-lookup). These need to be architecturally separated as the system grows.

---

## Critical Issues

### 1. No Materialized State — Cooldown Queries Will Degrade

**Severity: HIGH**

The spec stores discovery events in `.instar/state/discovery-events.jsonl` and derives cooldowns from this log. At 90 days of events, a query like "when was feature X last surfaced?" requires scanning the entire file backwards.

For a single agent with 10 features and 5 sessions/day, this file grows to ~1,350 records over 90 days — trivially fast to scan. But the architecture doesn't scale: there's no indexed lookup, no materialized current state, no TTL-based cleanup. The `maxSurfacesBeforeQuiet` counter is also implicit — derived by counting events — rather than stored as a first-class value.

**Recommendation:** Store current discovery state (one record per feature, not an event log) in SQLite alongside the event log. The event log is for auditing; the state table is for fast operational queries. Instar already has SQLite infrastructure — use it.

### 2. LLM Evaluator Has No Cost Ceiling or Deduplication Guard

**Severity: HIGH**

The spec says the evaluator runs "on every session start" and "when a problem is detected." It does NOT define:
- Maximum evaluations per time window
- Minimum context change threshold to trigger re-evaluation
- Deduplication: if the same session evaluates the same context twice in 5 minutes, that's wasted spend

At a single agent, this is noise. As instar scales toward multi-agent or multi-user, this becomes a real cost driver. The "not on every message" guard is necessary but insufficient.

**Recommendation:** Add a `minContextDeltaForReeval` threshold (e.g., >200 new tokens of conversation before re-evaluating) and a `maxEvaluationsPerSession` hard cap (e.g., 3). Cache the last evaluation result with a TTL. Define a cost budget per agent per day.

### 3. Per-User Discovery State Storage Architecture Is Unspecified

**Severity: MEDIUM-HIGH**

The spec says (in Open Questions): "Per-user vs per-agent discovery state? In multi-user setups, each user should have independent discovery state." This is hand-waved to "the implementation needs to handle it explicitly."

This is not a minor implementation detail — it's a data model decision that determines whether multi-user support requires a migration. The current spec's storage path (`.instar/state/discovery/`) implies per-agent storage. Adding per-user namespacing later is a breaking schema change.

**Recommendation:** Define the storage key schema now: `discovery/{userId}/{featureId}/state.json` or a SQLite table with `(userId, featureId)` as the composite key. Default `userId` to `"default"` for single-user deployments. This costs almost nothing to do upfront and prevents a painful migration later.

---

## Recommendations

### R1: Use SQLite for Discovery State, JSONL for Event Log

Store the current state of each feature's discovery (one row per feature per user) in SQLite with an index on `(userId, featureId)`. Keep `discovery-events.jsonl` for the audit trail — that's what JSONL is good at. This gives O(1) state lookups and O(n) event replay for analytics, which is the right tradeoff.

Instar already has `topic-memory.db` and `semantic.db` as precedent. A `discovery.db` follows the same pattern.

### R2: Cache LLM Evaluator Results With a Semantic TTL

Don't re-evaluate if the conversation hasn't changed meaningfully since the last evaluation. Store the last evaluation result (as a JSON blob) alongside a hash of the input context. If the hash matches within the session, return the cached result. This eliminates the most common redundant evaluations.

### R3: Define the Multi-User Data Model Before Phase 2 Ships

Add `userId` as a first-class field in all storage. Default to `"default"`. This costs one field and future-proofs the entire state machine. Don't ship Phase 2 persistence without it.

### R4: Add a `POST /features/evaluate-context` Rate Limiter

Even a simple in-memory rate limiter (max N calls per hour per agentId) prevents runaway evaluation loops from a bug or unexpected session-start retry storm. The endpoint should return a cached result if called within the rate limit window.

### R5: Add Aggregate Counters to the State Record

`maxSurfacesBeforeQuiet` is a setting, but the current surface count is implied (derived from scanning the event log). Store `surfaceCount` and `lastSurfacedAt` directly on the state record. This is a ~2-field addition that eliminates all log-scanning for operational decisions.

### R6: Define Feature Registry Size Limit and Pruning Strategy

The spec's `eligibleFeatures` array gets sent to the LLM evaluator. At 10 features this is fine. At 50 features (foreseeable as instar grows), the prompt is substantially larger and the LLM has more noise to filter. Define a maximum catalog size for the evaluator or implement a pre-filter that eliminates clearly ineligible features (wrong category, already enabled, in permanent cooldown) before the LLM sees them.

---

## Observations

### O1: The Event Log Retention Strategy Is Good But Incomplete

90-day retention on `discovery-events.jsonl` is the right call. However, the spec doesn't define the retention enforcement mechanism (a cron job? a cleanup on write?) or what happens to aggregate state if events are pruned. If `surfaceCount` is derived from the log and the log is pruned, the count resets. This needs to be explicit.

### O2: The State Machine Is Correct and Well-Designed

The `undiscovered → aware → interested → declined → enabled → disabled` state machine is clean, properly handles the "context changed materially" re-entry path, and the `maxSurfacesBeforeQuiet` safety valve is the right mechanism. The design is sound; the persistence layer beneath it needs hardening.

### O3: The 30% Enable Rate Success Criterion Is Ambitious But Unverifiable Without Baseline

The spec targets >30% enable rate for contextual suggestions. Industry data on feature adoption from SaaS products suggests contextual tooltips/nudges achieve 15-40% engagement depending on timing relevance. The 30% target is plausible for highly contextual suggestions but requires measurement infrastructure (the Phase 5 funnel metrics) to validate. The success criterion is good — just note it cannot be evaluated until Phase 5 is live.

### O4: "Materially Changed Context" Is LLM-Evaluated — That's the Right Call

Using LLM intelligence to evaluate whether context has "changed materially" (for the `declined → aware` re-entry) is explicitly called out in the spec and aligns with the CLAUDE.md principle of preferring intelligence over string matching. This is correct. The concern is cost, not correctness.

### O5: The Autonomy Profile Integration Is Clean

Mapping `cautious/supervised/collaborative/autonomous` to discovery behavior is elegant and reuses existing infrastructure. No scaling concerns here — it's a single read per evaluation.

### O6: "Negative Discovery" Open Question Has Real Scalability Value

The spec raises negative discovery ("you have this enabled but haven't used it in 60 days") as an open question. This has an underappreciated scalability benefit: it keeps the `eligibleFeatures` catalog small by actively pruning the enabled-but-unused set, which reduces LLM evaluator prompt size and cognitive load on the user. Worth elevating from an open question to Phase 5 scope.

---

## Scalability Assessment by Phase

| Phase | Scalability Rating | Key Risk |
|-------|-------------------|----------|
| Phase 1: Feature Registry | 8/10 | Low risk. Config iteration + static registry. No query patterns to worry about at this scale. |
| Phase 2: Discovery State Machine | 5/10 | High risk. JSONL-only persistence without materialized state will degrade. Multi-user schema not defined. Ship with SQLite state store or accept migration debt. |
| Phase 3: Context Evaluator | 6/10 | Medium risk. LLM cost is manageable at current scale but has no ceiling. Needs rate limiting and caching before any horizontal scaling. |
| Phase 4: Agent Integration | 9/10 | Low risk. Template and documentation updates. No infrastructure scaling concerns. |
| Phase 5: Observability | 7/10 | Medium risk. Analytics aggregation over JSONL event log will be slow at scale. Pre-aggregate metrics or migrate to SQLite before this phase. |

---

## Viral Spike Analysis

**Scenario: 1,000 new agents onboard in one hour**

- **Feature Registry endpoint (`GET /features`):** Stateless read from config. Handles the spike trivially. No concern.
- **Discovery evaluator (`POST /features/evaluate-context`):** 1,000 session starts × 1 LLM call each = 1,000 concurrent Haiku requests. Anthropic rate limits apply (typically 1,000-4,000 RPM on Haiku tier). This could queue but won't fail — Haiku has substantial rate limit headroom. Cost: ~$2 for the spike.
- **State writes to discovery store:** 1,000 concurrent writes to JSONL or file system. JSONL append is O(1) per write but file system doesn't natively serialize concurrent appends — race conditions are possible without explicit locking. SQLite in WAL mode handles concurrent writes safely. This is another argument for SQLite over JSONL for state.
- **Cooldown lookups during spike:** If implemented as JSONL scans, 1,000 concurrent full-file scans would hammer disk I/O. With SQLite indexed queries, this is a non-event.

**Graceful degradation:** The spec has no defined behavior for evaluator unavailability (e.g., Anthropic API timeout). The system should degrade gracefully to "surface nothing" rather than surfacing everything or erroring. This should be explicit in Phase 3.

---

## Summary

The Consent & Discovery Framework is conceptually excellent — the state machine design, consent tier model, and autonomy profile integration are all well-considered. The framework addresses a real gap in instar's feature surface. The scalability concerns are concentrated in the persistence layer (Phase 2) and the LLM evaluator (Phase 3).

**Ship Phase 1 as-is.** Address Phase 2 storage architecture before it ships. Rate-limit and cache the Phase 3 evaluator before any multi-agent deployment. The rest of the phases are low-risk.

The 30% feature enable rate target is ambitious but appropriate pressure. The success criteria are measurable once Phase 5 is live.

---

*Scalability review generated by Echo (instar developer agent) · Review ID 20260321-232155*

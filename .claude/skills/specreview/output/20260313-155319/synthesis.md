# SpecReview Synthesis: LearningExtractor

**Review ID**: 20260313-155319
**Date**: 2026-03-13
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Overall Status**: NEEDS WORK
**Average Score**: 6.9/10

## Score Summary
| Reviewer | Score | Status |
|----------|-------|--------|
| Security | 6/10 | CONDITIONAL |
| Scalability | 7/10 | CONDITIONAL |
| Business | 8/10 | APPROVE |
| Architecture | 8/10 | CONDITIONAL |
| Privacy | 7/10 | CONDITIONAL |
| Adversarial | 5/10 | CONDITIONAL |
| DX | 7/10 | CONDITIONAL |
| Marketing | 7/10 | CONDITIONAL |

## Consensus (findings 3+ reviewers agree on)

### 1. Prompt Injection via Message Content into Analysis LLM (6 reviewers)
**Flagged by:** Security, Adversarial, Architecture, DX, Privacy, Scalability

The single strongest signal across the entire review. Raw message content is concatenated directly into the LLM analysis prompt with no sanitization, escaping, or structural isolation. This is a textbook indirect prompt injection vector (OWASP LLM01:2025). Every reviewer who examined the data flow flagged this independently.

### 2. Unvalidated LLM Output Written to Evolution Registry (5 reviewers)
**Flagged by:** Security, Adversarial, Architecture, Privacy, Scalability

LLM-generated findings are passed directly to `EvolutionManager.addLearning()`, `addProposal()`, and `addGap()` with no content validation beyond JSON structure. This creates a write-once, amplify-many pipeline: poisoned findings persist in the registry, get synthesized by `insight-harvest` every 8 hours, and could eventually graduate to Playbook context or CLAUDE.md modifications.

### 3. In-Memory Rate Counter Resets on Server Restart (6 reviewers)
**Flagged by:** Security, Scalability, Architecture, Privacy, Adversarial, DX

`analysesThisHour` is a plain in-memory integer with no persistence. Server restart resets the cost control mechanism to zero. Universal agreement that this needs persistence to the state file.

### 4. Bridge/Relay Message Privacy Gap (6 reviewers)
**Flagged by:** Privacy, Security, Adversarial, Architecture, Business, Scalability

Open Question #4 in the spec was independently flagged by nearly every reviewer as needing resolution before build, not deferral. User-originated content forwarded through bridge/relay channels flows to a third-party LLM without consent. Universal recommendation: exclude bridge content by default with opt-in.

### 5. Evidence Excerpts Stored Without Scrubbing or TTL (4 reviewers)
**Flagged by:** Privacy, Security, Adversarial, DX

The `evidence` field in findings can contain message text excerpts that persist indefinitely in the evolution system. This violates data minimization principles and creates a secondary content retention vector the spec claims doesn't exist.

### 6. No Deduplication on Evolution Writes (4 reviewers)
**Flagged by:** Security, Scalability, Architecture, Adversarial

Repeated extraction of the same behavioral pattern across multiple flushes generates duplicate learnings. Over time this degrades signal quality in the evolution registry and skews `insight-harvest` synthesis.

### 7. No Concurrency Guard on flush() (4 reviewers)
**Flagged by:** Scalability, Architecture, Adversarial, DX

Two concurrent `flush()` calls can be in flight simultaneously, both having passed the rate limit check before either incremented the counter. Minor over-spend risk but a correctness gap.

### 8. Cost Model Underestimates Real Token Usage (3 reviewers)
**Flagged by:** Scalability, Architecture, DX

The spec estimates ~2000 input tokens per analysis; realistic estimates are 2500-4000. Monthly ceiling is closer to $55 than $26. Still inexpensive, but the stated numbers are ~2x off.

## Critical Issues (any reviewer blocked or flagged as must-fix)

| # | Issue | Flagged By | Severity | Recommended Fix |
|---|-------|-----------|----------|----------------|
| 1 | **Prompt injection via message content** | Security, Adversarial, Architecture, Privacy, Scalability, DX | P0 / Critical | Wrap message content in clearly delimited data blocks (XML tags or random-delimiter fences). Add explicit LLM instruction to treat content as inert data. Strip/escape prompt boundary patterns. |
| 2 | **Unvalidated LLM findings to EvolutionManager** | Security, Adversarial, Architecture, Privacy, Scalability | P0 / Critical | Validate `type` against enum, cap field lengths (title 100, description 500-1000 chars), strip instruction-like patterns, rate-limit writes per flush, consider `requiresReview` flag for auto-extracted findings. |
| 3 | **High-signal fast-track as oracle/DoS vector** | Adversarial | P1 / High | Apply separate stricter rate limit for high-signal flushes (e.g., max 3/hour). Introduce minimum inter-flush interval of 2 minutes even for high-signal events. |
| 4 | **Bridge message content to external LLM without consent** | Privacy, Security, Adversarial, Architecture, Business, Scalability | P1 / High | Add `contentOrigin` flag to ReviewEntry. Default `excludeBridgeContent: true`. Exclude user-sourced content in `shouldAnalyze()`. |
| 5 | **Evidence excerpts persist without TTL or scrubbing** | Privacy, Security, Adversarial | P1 / High | Define evidence as pattern descriptors only (message indices, not text). Document constraint in Finding type and LLM prompt. |
| 6 | **In-memory rate counter resets on restart** | Security, Scalability, Architecture, Privacy, Adversarial, DX | P2 / Medium | Persist `analysesThisHour` and `hourWindowStart` to state file on every increment. Reload on startup. |
| 7 | **Buffer drain on high-signal discards non-high-signal messages** | Architecture | P2 / Medium | Restructure `ingest()` to separate flush-now vs. reset-timer paths. Always call `resetFlushTimer()` after any flush. |
| 8 | **`LearningSource` type mismatch** | DX | P2 / Build-breaker | Align with actual `LearningSource` interface in `src/core/types.ts`. Remove non-existent `discoveredAt` field. |
| 9 | **Callback fires after return (logically impossible)** | DX | P2 / Build-breaker | Fire callback synchronously before return, or use `Promise.resolve().then()` for fire-and-forget microtask. |
| 10 | **No graceful shutdown / flush-on-destroy** | DX | P2 / Medium | Add `async destroy()` that clears timer, flushes remaining buffer best-effort, persists final stats. |
| 11 | **Unbounded buffer with no size ceiling** | Scalability | P2 / Medium | Add `maxBufferSize` config (default 100). Drop oldest entries when full. Increment `droppedMessages` counter. |
| 12 | **Name "LearningExtractor" under-sells the feature** | Marketing | Conditional | Rename to "Reflector" (recommended) or "PatternWatch". Current name is mechanical and cold. |

## Conflicts (where reviewers disagree)

### Inbound Message Tapping (Open Question #2)
- **Business** recommends resolving the architectural decision now (even if implementation deferred) because user corrections are the highest-value signal source.
- **Scalability** agrees it's worth pursuing in v2 as a `MessageReceived` event on the inbound path.
- **Privacy** flags that this would cross the line from "agent monitors itself" to "agent analyzes user behavior" and would require a separate privacy review, GDPR Article 6 lawful basis, and disclosure.
- **Security** notes it would "introduce a substantially larger attack surface" and should be treated as a separate, higher-risk feature.

**Resolution**: There is no disagreement on value — all reviewers agree inbound signals are high-value. The disagreement is on timing and risk. The privacy and security concerns are real and should gate implementation. Resolve the architectural decision now (Business is right), but implement only after a dedicated privacy/security review (Privacy and Security are right).

### Deduplication Strategy (Open Question #3)
- **Architecture** says tag with `source: 'learning-extractor'` and let `insight-harvest` handle it — the concern is overblown.
- **Security** and **Scalability** want a deduplication cache with TTL at the LearningExtractor level to prevent duplicate writes.
- **DX** recommends adding `'auto-extracted'` tag and having `insight-harvest` filter/weight differently.

**Resolution**: These are complementary, not conflicting. Tag at the source (Architecture/DX recommendation) AND add a short-term dedup cache to prevent rapid-fire duplicates from high-signal events (Security/Scalability recommendation). Both are cheap to implement.

### Severity of Rate Counter Reset
- **Adversarial** and **Security** treat it as a real exploitable gap (crash-loop = unlimited LLM calls).
- **Architecture** offers a documentation fix as an acceptable alternative to persistence.
- **Scalability** calls it "negligible cost" at current pricing but worth fixing.

**Resolution**: Persist the counter. It's ~10 lines of code and closes a gap that every reviewer flagged. The documentation-only option is insufficient given 6/8 reviewers identified it.

## Gaps (areas no reviewer covered)

1. **Testing strategy**: No reviewer addressed how to test the LearningExtractor — unit tests for `shouldAnalyze()` filters, integration tests for the flush pipeline, mock LLM responses for `parseFindings()`. A feature this security-sensitive needs a test plan.

2. **Monitoring and alerting**: Stats counters exist but no reviewer addressed when/how alerts should fire. What `analysesThrottled` threshold warrants attention? What `parseErrors` rate indicates the LLM prompt needs tuning?

3. **Rollback/disable path**: If the feature causes problems in production, what's the recovery procedure? Is `enabled: false` + server restart sufficient? Are poisoned evolution entries cleaned up?

4. **Configuration validation**: No reviewer checked whether invalid config values (negative `bufferSize`, zero `maxAnalysesPerHour`, empty `excludeChannels`) are handled gracefully.

5. **Versioning of the LLM prompt**: The analysis prompt will likely be tuned over time. No versioning strategy is discussed — changes to the prompt could silently alter finding quality without visibility.

## Recommendations (prioritized by cross-reviewer consensus)

1. **Add prompt injection defenses to `buildBatchSummary`** — 6 reviewers. Structural isolation of message content from instruction space. This is the single highest-priority fix.

2. **Add validation layer between LLM output and EvolutionManager writes** — 5 reviewers. Field validation, length caps, content sanitization, rate limiting on writes.

3. **Exclude bridge/relay content by default** — 6 reviewers. Add `contentOrigin` field, default to excluding user-sourced content. Closes the primary privacy gap.

4. **Persist the hourly rate counter** — 6 reviewers. Write counter + window timestamp to state file. Reload on startup.

5. **Scrub evidence fields to pattern descriptors only** — 4 reviewers. No message text in persisted findings. Prompt engineering fix.

6. **Add deduplication cache for evolution writes** — 4 reviewers. Hash-based short-term dedup to prevent rapid-fire duplicates.

7. **Fix buffer management** — 4 reviewers. Add size ceiling, concurrency guard on `flush()`, and defined overflow strategy when rate-limited.

8. **Fix DX build-breakers** — DX reviewer. `LearningSource` type mismatch, post-return callback, convergence `blockedBy` check that never fires. These will break the build.

9. **Add graceful shutdown** — 2 reviewers. `destroy()` method with best-effort flush.

10. **Update cost model** — 3 reviewers. Realistic token estimates are ~2x the stated numbers. Still cheap, but documentation should be accurate.

11. **Rename the feature** — Marketing. "Reflector" recommended. Current name is functional but uninspiring.

12. **Define success metrics** — Business. Ratio of cited learnings, reduction in ConvergenceChecker triggers, user-perceived improvement score.

## Scalability Summary

| Phase | Assessment | Key Risks |
|-------|-----------|-----------|
| MVP (single agent, ~50 msgs/day) | **Works as designed.** Cost is pennies. Buffer and rate limiter are adequate. All reviewers agree the architecture is sound at this scale. | Prompt injection surface exists from message #1. Fix before any deployment. In-memory counter reset is theoretical but cheap to fix. |
| Growth (10x: multi-session, ~500 msgs/day) | **Works with fixes.** Buffer-full triggers dominate. Rate limiter starts throttling during busy hours. Dedup gap becomes visible (10-20 variants of same 3 observations within a week). | Cost model 2x off — monthly ceiling closer to $55 not $26. Deduplication and minimum batch size for timer flush become important. Evidence retention scales linearly with findings. |
| Scale (100x: fleet deployment, 1000+ agents) | **Requires architectural changes.** Per-agent design does not support cross-agent pattern detection. No shared aggregation layer. Cost cliff: ~$9,600/month at fleet scale. | Cross-agent poisoning (one compromised agent poisons all via aggregation). Needs cryptographic provenance on findings. Batch API pricing and prompt caching required. New privacy review needed for cross-agent data flows. |

## Open Questions Resolution

### Open Question 1: Should CoherenceGate's full specialist reviewer details flow into ReviewEntry?
**Reviewer consensus: Yes.** Architecture calls this a "should fix" for v1 — the per-reviewer breakdown is the richest signal and costs ~20 lines to add. Without it, the LLM analyst sees only "BLOCKED" and must infer the reason from message text alone. DX notes that the `blockedBy: 'convergence'` check in `isHighSignal()` will never fire because convergence checker only generates warnings, not blocks — fix this while adding reviewer details.

### Open Question 2: Should the extractor also tap inbound messages for user correction signals?
**Reviewer consensus: Resolve the decision now, defer implementation.** Business says this is the highest-value signal source. Scalability agrees it's worth v2. Privacy and Security flag it as a separate, higher-risk feature requiring its own review (crosses from self-monitoring to user behavioral analysis). Recommendation: design the inbound hook point now so v1's architecture accommodates it, but gate implementation on a dedicated privacy/security review.

### Open Question 3: How should auto-extracted findings interact with insight-harvest?
**Reviewer consensus: Tag and deduplicate.** Architecture says tag with `source: 'learning-extractor'` and let insight-harvest handle weighting. Scalability and Security add: implement a short-term dedup cache (hash-based, 1-hour TTL) at the extractor level to prevent rapid-fire duplicates from high-signal events. DX recommends `'auto-extracted'` tag so insight-harvest can filter/weight differently. These are complementary — do all three.

### Open Question 4: For bridge messages forwarding user content, should these be excluded?
**Reviewer consensus: Yes, exclude by default.** This is the most unanimous recommendation across the review. 6 of 8 reviewers flagged this independently. Add a `contentOrigin` field to ReviewEntry, default to excluding user-sourced content, allow opt-in for operators who have informed their users. Privacy notes GDPR Article 6 requirements. Business notes this must be resolved before any enterprise positioning.

## Next Steps

- [ ] Address P0 critical issues: prompt injection defenses and evolution write validation
- [ ] Address P1 issues: high-signal rate limiting, bridge content exclusion, evidence scrubbing
- [ ] Fix DX build-breakers: `LearningSource` type, callback timing, convergence `blockedBy` check
- [ ] Persist hourly rate counter to state file
- [ ] Add buffer size ceiling and concurrency guard
- [ ] Add graceful shutdown / `destroy()` method
- [ ] Update cost model with realistic token estimates
- [ ] Resolve all 4 open questions per reviewer consensus above
- [ ] Consider rename to "Reflector" (marketing recommendation)
- [ ] Define success metrics before shipping
- [ ] Re-run review if major changes made (especially after prompt injection fixes)

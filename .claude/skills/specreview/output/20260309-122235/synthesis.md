# SpecReview Synthesis: Response Review Pipeline

**Review ID**: 20260309-122235
**Date**: 2026-03-09
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX, Marketing
**Overall Status**: NEEDS WORK
**Score Summary**: Average 6.6/10 | Min 5/10 (Adversarial) | Max 7.5/10 (Architecture)

| Reviewer | Score | Status |
|----------|-------|--------|
| Security | 6/10 | Conditional Approval |
| Scalability | 7/10 | Conditional Approval |
| Business | 7/10 | Conditional Approve |
| Architecture | 7.5/10 | Approved with Conditions |
| Privacy | 6/10 | Conditional Approval |
| Adversarial | 5/10 | Conditional Reject |
| DX | 7/10 | Conditional Approve |
| Marketing | 7/10 | Conditional Approve |

---

## Consensus (findings 3+ reviewers agree on)

### 1. The gate-then-fan-out architecture is sound (8/8 reviewers)
Every reviewer affirmed the core pattern: a fast gate reviewer that skips 60-70% of simple messages, followed by parallel specialist reviewers. This is the industry-standard funnel approach and the cost model depends on it working as designed.

### 2. Fail-open is correct but needs per-channel configuration (6/8 reviewers)
Security, Scalability, Architecture, Adversarial, Privacy, and DX all engaged with `failOpen: true`. The consensus: correct for CLI/internal channels, dangerous for Telegram/external channels. Security and Adversarial call it a critical vulnerability for external-facing messages. Scalability and Architecture call it correct for availability. The resolution is clear: **per-channel fail-open/fail-closed configuration**, with external channels defaulting to fail-closed (queue-and-hold, not block-forever).

### 3. Incident-driven design (Appendix A) is exceptional (5/8 reviewers)
Security, Business, Architecture, Adversarial, and DX all praised the grounding of every reviewer in real, documented agent failures. Business and Marketing both identified it as publishable content. Architecture called it "rare in specs." This is the strongest signal that the design is solving real problems, not hypothetical ones.

### 4. The value hierarchy grounding is genuinely novel (5/8 reviewers)
Business, Architecture, Marketing, DX, and Privacy all noted that grounding review in a three-tier value hierarchy (AGENT.md / USER.md / ORG-INTENT.md) is something no competitor does. Marketing calls it "the moat." Architecture calls it "architecturally novel." This is the spec's biggest differentiator and should be the leading message.

### 5. Reviewers lack conversation context, undermining key checks (4/8 reviewers)
Architecture, Business, Adversarial, and DX all flagged that reviewers only see the current message, not the conversation or tool output that preceded it. This critically undermines Claim Provenance (cannot verify if a number came from a tool) and Settling Detection (cannot distinguish genuine "not found" from laziness). Architecture recommends passing truncated recent tool output (~500 tokens) to at least these two reviewers.

### 6. Prompt caching must be designed in from day one (3/8 reviewers)
Scalability, Architecture, and DX all noted that reviewer system prompts are identical across invocations and prime candidates for Anthropic's prompt caching (10x cheaper reads). Scalability estimates 40-50% input cost reduction. Cached tokens also don't count toward rate limits, effectively doubling throughput headroom.

### 7. The replacement of existing hooks should be gradual (3/8 reviewers)
Business, Architecture, and Adversarial all recommend running the new pipeline in shadow/parallel mode alongside existing hooks (convergence-check.sh, claim-intercept-response.js) before retiring them. Track agreement rates, validate coverage, then transition.

### 8. Reviewer count scaling needs structural limits (3/8 reviewers)
Architecture, DX, and Scalability all note that 7 reviewers is at the manageable upper bound, and the 8 additional reviewers identified in Appendix A would fundamentally change the cost/latency calculus. Architecture recommends a hard cap (max 10) with merge-or-replace semantics. DX recommends tiered execution. Scalability recommends conditional execution based on message characteristics.

---

## Critical Issues (any reviewer blocked or conditionally rejected)

### P0: Prompt Injection via Agent Response Content (Security, Adversarial)
The agent's response is injected between static `---` delimiters in reviewer prompts. An adversary who can influence the agent's output can embed instructions that manipulate the reviewer. Research shows 30-74% attack success rates on LLM-as-judge systems. Both reviewers independently recommend: randomized unique delimiters, anti-injection preambles, structured message passing (XML/JSON escaping), and output validation.

### P0: Gate Bypass Enables Full Pipeline Evasion (Security, Adversarial)
The gate reviewer is a single Haiku call that determines whether full review occurs. An attacker who can craft inputs producing "simple-looking" responses bypasses all specialist reviewers. Security recommends mandatory full review for external channels plus probabilistic sampling. Adversarial notes the gate criteria are broad and learnable.

### P0: Fail-Open on External Channels (Security, Adversarial, Privacy)
`failOpen: true` for Telegram/external channels means any API outage or deliberate timeout silently disables the entire quality layer. Adversarial identifies this as a "trivially exploitable kill switch." Must be per-channel with fail-closed + queue-and-hold for external channels.

### P0: Claude Judging Claude -- Family Bias (Adversarial)
Published research confirms LLMs systematically favor output from their own model family. The agent is Claude; the reviewer is Haiku (Claude family). This creates a structural blind spot. Adversarial recommends at least some reviewers use a non-Claude model, or add explicit Claude-typical failure patterns to reviewer prompts.

### P0: Feedback Loop Trains Evasion, Not Improvement (Adversarial)
The pipeline returns specific reviewer names, specific issues, and specific suggestions when it blocks. Over repeated interactions, the agent accumulates a precise model of what each reviewer checks for and learns to evade rather than improve. This is the adversarial reviewer's central concern. Recommendations: don't expose reviewer names (use generic categories), rotate prompt variations, add a meta-reviewer detecting gaming patterns, track revision similarity.

### P0: No User Consent or Transparency Mechanism (Privacy)
Every substantive response is sent to Anthropic's Haiku API with no user disclosure, no consent mechanism, and no opt-out. GDPR Articles 13, 14, and 22 require transparency about automated processing. The pipeline must inform users that responses are reviewed by a secondary AI system.

### P0: No Data Minimization (Privacy)
Full message content (potentially containing PII, health data, financial details) is sent to all reviewers. No PII detection/scrubbing. No per-reviewer content scoping (URL Validity only needs URLs, not the full message). GDPR Article 5(1)(c) requires data minimization.

### P0: No DPIA Conducted (Privacy)
Systematic monitoring of agent-to-user communications with external API transmission triggers GDPR Article 35's Data Protection Impact Assessment requirement. None is mentioned.

### P0: Stop Hook Output Contract is Misspecified (Architecture)
The spec describes two contradictory blocking mechanisms (exit code 2 vs. JSON stdout) and contradicts itself on whether the pipeline runs during retries. Must pick one mechanism and clarify retry semantics.

### P0: No Custom Reviewer Interface (DX)
Every comparable system (Guardrails AI, NeMo, OpenAI SDK) makes custom validators a first-class concept. The spec defines no interface for operator-created reviewers, no registration mechanism, and no extension path without modifying instar source code.

### P0: No Dry-Run or Testing Facility (DX)
No way to test reviewers against sample messages, run in observe-only mode, or replay historical messages through updated reviewers. Essential for tuning sensitivity and iterating on prompts.

### P0: Feature Name is Wrong (Marketing)
"Response Review Pipeline" is an engineering label, not a product name. Marketing strongly recommends "Coherence Gate" -- already used in the spec, not claimed by competitors, captures the identity-awareness differentiator.

---

## Conflicts (where reviewers disagree)

### Fail-Open: Scalability vs. Security/Adversarial/Privacy
- **Scalability** calls `failOpen: true` "correct for scalability" and the "right default."
- **Security** calls it "inappropriate for external channels" and a critical vulnerability.
- **Adversarial** calls it an "exploitable kill switch."
- **Privacy** calls it "privacy-positive but quality-negative."
- **Resolution**: Per-channel configuration. Fail-open for CLI/internal (Scalability wins). Fail-closed with queue-and-hold for Telegram/external (Security wins).

### Cost Estimates: Spec vs. Scalability
- **The spec** claims ~$0.001 per full review, $1.20/month.
- **Scalability** calculates ~$0.005 per full review (5x higher) due to output tokens costing 5x input. Actual estimate: $5-6/month per agent.
- **Resolution**: Recalculate. The spec underestimates by 5x. Still cheap, but accurate projections matter for fleet planning.

### Reviewer Feedback Specificity: DX vs. Adversarial
- **DX** wants richer, more specific feedback to improve the debugging experience.
- **Adversarial** wants less specific feedback (generic categories, no reviewer names) to prevent evasion learning.
- **Resolution**: Two feedback channels. Specific feedback to operator audit logs (for debugging). Generic categorical feedback to the agent (for revision). The agent gets "tone issue" not "Conversational Tone reviewer flagged file path on line 3."

### Value Alignment Reviewer Scope: Privacy vs. Business/Architecture
- **Privacy** flags that sending AGENT.md, USER.md, and ORG-INTENT.md to Anthropic's API for every review is a data exposure concern (confidential business rules, user preferences).
- **Business** and **Architecture** call the value hierarchy the spec's greatest innovation and competitive moat.
- **Resolution**: Summarize aggressively. Send bullet-point extracts, not full documents. Cache summaries. Consider whether the value check can use local heuristics before escalating to API.

### P0 Additional Reviewers: Business vs. Architecture
- **Business** says the P0 additional reviewers (Confidence Calibration, Deferral/Initiative, Role Coherence) should ship in Phase 1 because they address the most damaging documented incidents.
- **Architecture** says 7 reviewers is already at the upper bound and recommends a hard cap of 10.
- **Resolution**: Merge rather than append. Integrate Confidence Calibration into Claim Provenance. Integrate Deferral/Initiative into Capability Accuracy. Keep the cap manageable.

---

## Unique Findings (things only one reviewer caught)

### Security: Timing Side Channels via `duration_ms`
Response timing reveals whether the gate triggered full review, how many reviewers flagged, and whether fail-open was triggered. Remove `duration_ms` from user-facing responses; keep in server-side logs only.

### Security: Value Hierarchy Files as Attack Surface
If AGENT.md or USER.md is compromised (via git sync from a compromised machine, or adversarial session writing to MEMORY.md), the Value Alignment reviewer itself becomes compromised. Recommends integrity verification and read-only startup snapshots.

### Scalability: Cold Start Latency
First review after server start won't benefit from prompt caching and may have higher latency. Recommends a warm-up call at server start to prime the cache.

### Scalability: Rate Limit Headers as a Degradation Signal
The pipeline should read `anthropic-ratelimit-requests-remaining` from API responses and degrade gracefully (fewer reviewers) when headroom is low.

### Architecture: `Promise.allSettled` vs. `Promise.all`
`Promise.all` rejects the entire batch if one reviewer times out. `Promise.allSettled` collects all results, treating errors as "no opinion." This aligns with fail-open semantics and should be the default.

### Architecture: Multiple Stop Hooks Create Ordering Dependencies
The new pipeline hook alongside existing claim-intercept-response.js and scope-coherence-checkpoint.js creates a sequential chain with shared `stop_hook_active` state. Double-block situations are possible. Must be managed explicitly.

### Privacy: Review History Creates a Communication Surveillance Dataset
The audit trail contains every substantive message plus what was flagged, revised, and the original vs. revised versions. If compromised, this reveals what the agent *tried* to say -- potentially more sensitive than final output.

### Privacy: Multi-User Privacy Boundaries Not Addressed
If different users interact with the agent, could User A's messages appear in review logs accessible to User B? Does the Value Alignment reviewer leak one user's preferences into another's review?

### Privacy: Anthropic as Both Provider and Reviewer
Claude generates the output; Haiku reviews it. No independent third-party oversight. Shared systematic biases would not be caught -- they'd be amplified.

### Adversarial: Minimal Edit Evasion
Agent gets blocked for a file path, changes it to "your configuration file," passes. Surface-level compliance without substance improvement. Recommends tracking semantic similarity between original and revised responses.

### Adversarial: Whitelisted Domain Abuse
URL Validity whitelists github.com, vercel.app, etc. An agent can fabricate URLs on whitelisted domains that don't exist. Need pattern-level whitelisting or tool-output verification.

### Adversarial: Non-English Response Blindspot
All reviewer prompts are English. Multilingual responses may not be accurately assessed. Known limitation that should be documented.

### DX: Aggregation Logic for Mixed Block/Warn Verdicts is Undefined
The spec shows both BLOCK and WARN in feedback but never defines whether warnings block, accumulate to blocks, or just log. Must be specified before implementation.

### DX: Reviewer Overlap Creates Noise
Claim Provenance and URL Validity both check fabricated URLs. Capability Accuracy overlaps with proposed Deferral/Initiative. Multiple reviewers flagging the same issue wastes revision cycles.

### Marketing: Reviewer Categories for User-Facing Communication
Group 7+ reviewers into 4 intuitive categories: Voice (tone, channel), Truth (claims, URLs, confidence), Character (capabilities, role, values), Judgment (settling, context, proportionality).

### Business: First-Mover Window is 6-12 Months
No competitor has shipped identity-grounded response review. The market positions guardrails (safety) and eval tools (measurement) but nothing for coherence (identity). Window estimated at 6-12 months.

---

## Strengths (what the spec does well)

1. **Incident-driven design** -- Every reviewer traces to a real, documented failure. The coverage gap analysis is honest about what isn't covered. This is rare and significantly increases confidence. (Security, Business, Architecture, Adversarial, DX)

2. **Three-tier value hierarchy** -- Grounding review in agent/user/org declared values is genuinely novel. No competitor does this. It makes the pipeline agent-specific rather than generic. (Business, Architecture, Marketing, DX)

3. **Gate-then-review economics** -- The 60-70% skip rate makes the cost model viable at ~$0.04-0.17/day per agent. This is better than Guardrails AI (validate everything) or NeMo (rule-based filtering). (All reviewers)

4. **Thin hook, thick server** -- Keeping intelligence server-side means reviewer updates don't require hook redistribution. The server can evolve the pipeline without touching agent installations. (Architecture, DX)

5. **Fail-open as default** -- Correct for a quality layer (vs. security layer). Prevents the review system from becoming a single point of failure that blocks all communication. (Scalability, Architecture, Business, DX)

6. **Honest coverage gap analysis** -- The spec explicitly identifies what the current 7 reviewers do NOT catch. This intellectual honesty is a design strength. (Architecture, Business, Adversarial)

7. **Cost profile** -- Even at the corrected $5-6/month estimate, this is negligible per agent and removes the primary adoption objection. (Business, Scalability, Marketing)

---

## Prioritized Recommendations

### 1. Harden Against Prompt Injection (P0 -- Security, Adversarial)
Use unique randomized delimiters per request, anti-injection preambles, structured message passing (XML/JSON escaping), and strict output validation on reviewer responses. This is the single highest-impact security fix.

### 2. Per-Channel Fail-Open/Fail-Closed Configuration (P0 -- Security, Adversarial, Privacy)
External channels (Telegram) default to fail-closed with queue-and-hold (30-second timeout, then deliver with warning flag). CLI/internal channels keep fail-open. Log all fail-open events.

### 3. Pass Truncated Tool Output to Key Reviewers (P0 -- Architecture, Business, DX)
Claim Provenance and Settling Detection are fundamentally limited without conversation context. Pass last 3-5 tool results (~500 tokens) from the transcript. The `transcript_path` is already available in stop hook input.

### 4. Implement User Transparency and Data Minimization (P0 -- Privacy)
Disclose the review data flow to users. Add PII detection/scrubbing. Send only minimum content each reviewer needs. Conduct a DPIA before deployment.

### 5. Rename to "Coherence Gate" (P0 -- Marketing)
The spec already uses this term. It captures the differentiator (identity, not safety), implies enforcement (gate, not review), and is unclaimed by competitors. Update config key to `coherenceGate`.

### 6. Fix Stop Hook Output Contract (P0 -- Architecture)
Pick one mechanism (JSON stdout with `{"decision": "block", "reason": "..."}` is recommended). Clarify retry semantics: when `stop_hook_active` is true, check server-side retry count; if under max, run pipeline; if at max, pass through.

### 7. Obfuscate Feedback to Prevent Evasion Learning (P0 -- Adversarial)
Don't expose reviewer names to the agent. Use generic categories. Rotate prompt variations. Log revision patterns to detect gaming (minimal edits that flip verdicts).

### 8. Implement Prompt Caching from Day One (P1 -- Scalability)
Cache reviewer system prompts and value hierarchy documents. 40-50% input cost reduction. Cached tokens don't count toward rate limits, doubling throughput headroom.

### 9. Add Dry-Run/Test Mode and Custom Reviewer Interface (P1 -- DX)
`POST /review/test` for testing individual reviewers against sample messages. `observeOnly` config mode for initial rollout. Define a `ReviewerSpec` interface for custom reviewers in `.instar/reviewers/`.

### 10. Shadow-Mode Rollout Before Retiring Existing Hooks (P1 -- Business, Architecture, Adversarial)
Run the new pipeline in parallel with existing hooks for 2-4 weeks. Track agreement rates. Validate coverage. Then transition.

---

## Scalability Summary

| Phase | Assessment | Key Risks |
|-------|-----------|-----------|
| 1-10 agents | GREEN -- No concerns | None. Cost trivial, rate limits irrelevant. |
| 10-50 agents | GREEN -- Minor optimization needed | Implement prompt caching (40-50% cost reduction). |
| 50-100 agents | YELLOW -- Rate limit bursts | Add rate limit awareness (read API response headers, degrade gracefully). |
| 100-500 agents | ORANGE -- Sustained RPM pressure | Tiered reviewer execution (conditional reviewers based on message characteristics). |
| 500-1,000 agents | RED -- RPM ceiling, $5K+/month | All optimizations required + Tier 4 API + request jitter. |
| 1,000+ agents | RED -- Requires custom limits | Contact Anthropic sales, consider multi-key strategy or regional partitioning. |

**Latency is the real bottleneck, not cost.** A 2-4 second review delay on every Telegram message degrades UX. If Haiku latency spikes to 5-10s (common during high traffic), the pipeline dominates response time. Adversarial recommends async review for non-blocking channels (send immediately, review in background, correct if needed).

**The gate bypass rate is the critical scaling variable.** If the 60-70% skip rate drops to 30%, costs double. Must be measured empirically in the first week and the cost model adjusted. Consider making gate criteria tunable in config.

---

## Next Steps

1. **Resolve the 4 specification contradictions** identified by Architecture (stop hook output contract, `skipWhenHookActive` semantics, retry behavior when `stop_hook_active` is true, and hook ordering with existing stop hooks).

2. **Address the 3 P0 security issues** before any deployment: prompt injection hardening, per-channel fail-closed, and gate bypass mitigation for external channels.

3. **Conduct a DPIA** and implement minimum transparency/consent mechanisms before processing user-facing messages through external APIs.

4. **Rename to "Coherence Gate"** throughout the spec, config keys, and API endpoints. Write the elevator pitch: "Guardrails stop your agent from saying dangerous things. The Coherence Gate stops it from saying things that don't sound like it."

5. **Add conversation context** (truncated recent tool output) to Claim Provenance and Settling Detection reviewers. Without this, two of the seven reviewers are structurally unreliable.

6. **Design the custom reviewer interface** and dry-run/test mode before implementation begins. These determine the extensibility ceiling.

7. **Plan the shadow-mode rollout**: run new pipeline in parallel with existing hooks for 2-4 weeks, tracking agreement rates and false positives, before retiring convergence-check.sh and claim-intercept-response.js.

8. **Implement prompt caching** in the initial architecture, not as a later optimization. The cost and rate-limit benefits are too significant to defer.

9. **Recalculate the cost model** including output tokens ($5/MTok). The spec's $0.001/review estimate is ~5x too low. Corrected estimate: ~$0.005/review, $5-6/month per agent at current volume.

10. **Publish Appendix A** (sanitized) as standalone content: "What Goes Wrong When AI Agents Talk to Users." This is both the best validation of the design and the strongest marketing asset.

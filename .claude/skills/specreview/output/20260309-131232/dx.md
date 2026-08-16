# DX / API Design Review: Coherence Gate — Round 2

**Review ID**: 20260309-131232
**Reviewer**: DX / API Design
**Round**: 2 (prior: 20260309-122235)
**Date**: 2026-03-09

## Approval Status: APPROVE

---

## Improvements Since Round 1

1. **Custom reviewer interface** (was P0) — NOW ADDRESSED. `ReviewerSpec` contract in JSON. Auto-discovery from `.instar/reviewers/`. LLM-powered (prompt field) and programmatic (script field) options. Per-reviewer `contextRequirements` specifying exactly what data the reviewer needs. This is a first-class extension point.

2. **Dry-run / testing facility** (was P0) — NOW ADDRESSED. `POST /review/test` endpoint. Supports single-reviewer testing, full pipeline testing, and returns per-reviewer latency. Combined with `observeOnly` config for shadow mode during rollout.

3. **Aggregation logic defined** (was P0) — NOW ADDRESSED. Clear rules: block-mode fail = BLOCK, warn-only = PASS with feedback, configurable escalation threshold (3 warnings = block), timeout = abstain. No ambiguity.

4. **Reviewer overlap resolution** (was unique finding) — NOW ADDRESSED. The reviewer responsibility matrix defines primary concerns, required context, and overlap resolution rules. Deduplication in feedback composition groups redundant flags as single actionable items.

5. **Stop hook output contract** — NOW ADDRESSED (via architecture). JSON stdout exclusively, always exit 0. No ambiguity for implementers.

---

## Research Findings

- **Guardrails AI DX**: Uses RAIL (XML-based) spec for defining validators. SDK available for Python. Custom validators are functions decorated with `@register_validator`. Clean but XML-heavy for simple use cases.
- **NeMo Guardrails DX**: Custom language (Colang) for defining conversational flows. Steeper learning curve but more expressive for dialog control. Config is YAML-based.
- **Promptfoo DX**: YAML-based test definition. `promptfoo eval` CLI for running evaluations. Excellent testing ergonomics — define expected outputs, run against prompts, get a report.
- **Common pattern**: The best DX in this space comes from file-based configuration (YAML/JSON), declarative interfaces, and CLI testing tools. The Coherence Gate's JSON-based `ReviewerSpec` + `POST /review/test` aligns with these patterns.

---

## Critical Issues (must fix before building)

None. All Round 1 DX-critical issues have been resolved.

---

## Recommendations (should fix, not blocking)

### 1. CLI Testing Command (HIGH)
**Section**: Dry-Run and Testing

The `POST /review/test` endpoint is excellent for programmatic testing. But the most common use case is an operator testing a message from the command line. A CLI wrapper would dramatically improve the testing experience:

```
instar gate test "Your message to test" --channel telegram --reviewer claim-provenance
instar gate test --file sample-messages.jsonl --all  # batch testing
instar gate stats  # reviewer effectiveness dashboard
instar gate health  # per-reviewer health check
```

**Suggestion**: Add `instar gate` CLI subcommand that wraps the API endpoints. This is the DX layer that turns the API into a tool operators actually use daily.

### 2. Reviewer Development Workflow (MEDIUM)
**Section**: Custom Reviewer Interface

The `ReviewerSpec` contract is clean, but there's no guidance on the development workflow:
- How do you iterate on a custom reviewer prompt?
- How do you test it against a corpus of sample messages?
- How do you see what it would have caught historically?

**Suggestion**: Document a recommended workflow: (1) Write ReviewerSpec JSON, (2) Test with `POST /review/test` against sample messages, (3) Enable in `observeOnly` mode, (4) Monitor with `GET /review/stats?reviewer=custom-name`, (5) Promote to `warn` then `block` mode. This could be a dedicated page in the docs or a skill.

### 3. Error Messages Should Guide Resolution (MEDIUM)
**Section**: General

The spec defines the happy path well but doesn't specify error messages for common failure scenarios:
- What does the agent see if the server is unreachable?
- What does the operator see if a custom reviewer has invalid JSON?
- What does `POST /review/test` return if the reviewer name doesn't exist?

**Suggestion**: Define error response schemas. E.g., `{"error": "reviewer_not_found", "message": "No reviewer named 'brand-voice'. Available: [list]", "suggestion": "Check .instar/reviewers/ for custom reviewer files."}` Good error messages are half the DX.

### 4. Reviewer Development Kit / Examples (LOW)
**Section**: Custom Reviewer Interface

The `ReviewerSpec` contract is documented with one example (brand-voice.json). For adoption, operators need:
- 3-5 example custom reviewers covering different use cases
- A "starter template" that works out of the box
- Examples of programmatic reviewers (script-based)

**Suggestion**: Ship example reviewers in `.instar/reviewers/examples/` (disabled by default). Include: brand-voice, compliance-check, language-filter, response-length. Each demonstrates a different `contextRequirements` pattern.

### 5. Dashboard Integration for Review Activity (LOW)
**Section**: Implementation Plan — Observability

The review stats and history are available via API endpoints. For operators who use the dashboard (web UI), surfacing review activity visually would complete the observability story:
- Recent review verdicts (pass/block/warn)
- Per-reviewer flag rates (bar chart)
- Revision patterns (how many retries on average)
- Canary test status

**Suggestion**: Add a "Coherence Gate" tab to the existing dashboard. This is a Phase 3/4 item but worth designing the data shape for now.

---

## Observations

1. **The `observeOnly` mode is the single most important DX feature.** It removes adoption risk completely. Operators can see what the gate would do for weeks before enabling blocking. This is how Prometheus, Datadog, and every successful monitoring tool achieved adoption — observe first, act later.

2. **The `ReviewerSpec` contract is well-designed.** JSON is the right choice (not YAML, not a custom DSL). The `contextRequirements` pattern (message, toolOutput, valueDocuments, channel, customContext) is expressive enough for most use cases without being overcomplicated.

3. **Per-reviewer mode configuration** (`block`, `warn`, `observe`) gives operators fine-grained control. New reviewers can start in `observe`, graduate to `warn`, then to `block`. This is a trust-building ramp.

4. **The generic feedback categories improve agent DX too.** The agent receives actionable feedback (`TONE ISSUE: rephrase technical references`) without information overload. Five categories is the right granularity — more would fragment attention, fewer would be too vague.

5. **The migration plan is excellent DX.** 5 weeks, clearly defined phases, rollback triggers. Operators know exactly what to expect and when. No Big Bang cutover.

---

## Scalability Assessment

| Phase | Assessment | DX Concerns |
|-------|-----------|-------------|
| MVP | GREEN | JSON config, test endpoint, observe mode. Clean onboarding for early operators. |
| Growth | GREEN | Custom reviewer interface enables power users. Review stats endpoint enables data-driven tuning. |
| Scale | YELLOW | Documentation debt — as more reviewers and config options accumulate, the configuration surface area grows. Need comprehensive docs and the CLI wrapper. |
| Viral spike | GREEN | DX doesn't degrade under load. New agents get the same clean onboarding experience. |

---

## Score: 8/10

**Justification**: Major improvement from Round 1 (was 7/10). All three P0 DX issues are resolved. The custom reviewer interface is a first-class extension point. The test endpoint enables rapid iteration. The observe-only mode removes adoption risk. The reviewer responsibility matrix eliminates the overlap confusion. Remaining items (CLI wrapper, development workflow guide, error message schemas, example reviewers) are polish that would elevate the DX from good to excellent. This is a developer-friendly system that operators can adopt confidently.

# Privacy & Ethics Review: Coherence Gate — Round 2

**Review ID**: 20260309-131232
**Reviewer**: Privacy & Ethics
**Round**: 2 (prior: 20260309-122235)
**Date**: 2026-03-09

## Approval Status: CONDITIONAL APPROVE

---

## Improvements Since Round 1

1. **User transparency** (was P0) — NOW ADDRESSED. Three-level disclosure: first-activation message, privacy notice via Telegraph, and opt-out path (per-channel config, per-topic disable). This satisfies GDPR Articles 13/14 transparency requirements.

2. **Data minimization** (was P0) — NOW ADDRESSED. The data minimization matrix specifies exactly what each reviewer receives. URL Validity gets only extracted URLs. Claim Provenance gets tool output but not value docs. Value Alignment gets summarized values but not tool output. PII scrubbing runs locally before any API call.

3. **DPIA requirement acknowledged** (was P0) — PARTIALLY ADDRESSED. The spec acknowledges the DPIA requirement and lists what it should cover, but positions it as "a compliance checkpoint, not a spec deliverable." This is acceptable for a design spec — the DPIA is an operational requirement before production deployment on external channels.

4. **Data retention specified** (was gap) — NOW ADDRESSED. 30-day active retention, then metadata-only archive (content purged). User deletion via `DELETE /review/history?sessionId=X`. Anthropic's API data retention policy referenced.

5. **Multi-user privacy boundaries** (was unique finding) — NOW ADDRESSED. Review history tagged with `userId`. Per-user querying. Per-user consent tracking. Cross-user isolation specified (User A's logs never accessible to User B).

6. **Value document handling** (was conflict) — NOW ADDRESSED. Deterministic summarization (markdown parsing, not LLM), ~200-400 tokens, prompt caching for cost/rate benefit. Better than sending full documents.

---

## Research Findings

- **GDPR and AI (2026)**: DPIAs are now standard gating steps for AI systems that materially affect individuals. The EU AI Act's high-risk AI requirements (transparency, human oversight) apply to systems making decisions about content delivery. The Coherence Gate's blocking mechanism makes decisions about what users see — this may classify as "automated decision-making" under GDPR Article 22.
- **EU AI Act timeline**: High-risk AI system requirements postponed due to standards delays, but transparency requirements for general-purpose AI are active. The Coherence Gate using Claude (a general-purpose AI model) as a judge falls under these transparency provisions.
- **GDPR Article 22 applicability**: The gate decides whether a message is delivered (BLOCK) or delayed (QUEUE). This is automated processing that affects the user experience. While it doesn't produce "legal effects," it could be argued to produce "similarly significant effects" if critical information is delayed or blocked. The opt-out path is the key mitigation.

---

## Critical Issues (must fix before building)

### 1. GDPR Article 22 — Automated Decision-Making Classification (MEDIUM-HIGH)
**Section**: Architecture Overview, Revision Flow

The Coherence Gate makes automated decisions about whether messages reach users:
- BLOCK: Message is suppressed, agent must revise
- QUEUE: Message is delayed up to 30-60 seconds
- After maxRetries: Message passes but with violations logged

While this primarily affects the *agent's* output (not a user's data), users are indirectly affected — they may receive delayed or modified responses. If a user sends a time-sensitive request and the response is queued for 60 seconds, the delay has material impact.

Under GDPR Article 22, automated decisions producing "similarly significant effects" require: the right to human intervention, the right to express a view, and the right to contest the decision.

**Suggested fix**: The opt-out path (per-topic disable via user request) already provides a form of contesting. Add to the privacy notice: "If you believe a response was incorrectly delayed or modified, you can ask the agent to disable review for your conversation." This frames the opt-out as a GDPR-compatible contesting mechanism. The attention queue (where maxRetries violations are logged) provides the human oversight layer.

### 2. Complaint Classifier Privacy Implications (MEDIUM)
**Section**: Organic Evolution — Complaint Detection

The complaint classifier runs a Haiku call on every incoming *user* message. This means:
- User messages are sent to Anthropic's API for classification
- This is a separate data flow from the response review (which reviews agent output)
- The user may consent to having agent responses reviewed but not expect their own messages to be classified

This is a distinct processing purpose that needs its own disclosure and legal basis.

**Suggested fix**: Include the complaint classifier in the transparency disclosure: "Incoming messages are also analyzed for satisfaction signals to improve response quality." Consider making the complaint classifier opt-in or providing a separate opt-out.

---

## Recommendations (should fix, not blocking)

### 1. PII Scrubbing Should Be Configurable (MEDIUM)
**Section**: Privacy, Consent, and Data Minimization — PII scrubbing

The 4-type PII scrubber (email, phone, API key, password) is a good start but may be insufficient for some jurisdictions. Different contexts have different PII definitions.

**Suggestion**: Make the PII patterns configurable. Provide a default set, but allow operators to add patterns (e.g., national ID formats for their jurisdiction). The custom reviewer interface pattern (file-based, auto-discovered) could apply here.

### 2. Anonymization in Upstream Signals (MEDIUM)
**Section**: Organic Evolution — Upstream Signal

The spec says signals are "sanitized before submission — extract the pattern, not the content." Good principle. But the implementation needs to be verified: the `agentResponseSnippet` and `userSignal` fields could contain PII even after "sanitization" if the sanitization is pattern-based rather than content-aware.

**Suggestion**: Run the same PII scrubber on upstream signals before transmission. Add a unit test that verifies no PII survives in test upstream signals.

### 3. Right to Explanation (LOW)
**Section**: Feedback Composition

The agent-facing feedback uses generic categories. The user never sees why their response was delayed or modified — only the agent sees feedback. If a user asks "why did your response take so long?" or "why did you change what you were about to say?", there's no mechanism for the agent to explain the review process in user-appropriate terms.

**Suggestion**: Add a standard explanation template the agent can use when asked: "I review my responses for quality before sending. Occasionally this adds a brief delay. You can ask me to skip this check."

---

## Observations

1. **The information boundary rule is a privacy feature, not just a security feature.** Preventing agent-to-external leaks of primary user context (name, work details, credentials) directly supports GDPR data minimization and purpose limitation. This should be highlighted in the DPIA.

2. **The per-user consent tracking is forward-looking.** Current scope is single-user, but the spec already defines per-user isolation. When multi-user ships, the privacy infrastructure is ready.

3. **Anthropic as both provider and reviewer** remains a structural concern (Round 1 unique finding). The spec adds cross-model validation (monthly sample with non-Claude model) which partially addresses bias but doesn't address the single-vendor data concentration. This is an inherent architectural choice — acceptable if disclosed.

4. **The data retention policy** (30 days active, metadata-only archive) is reasonable and GDPR-aligned. The `DELETE` endpoint for targeted purging supports right-to-erasure requests.

5. **Review history as a surveillance dataset** (Round 1 unique finding) remains valid. The history contains every substantive message plus what was flagged and revised. The 30-day content purge mitigates this significantly — metadata-only archives reveal patterns but not content.

---

## Scalability Assessment

| Phase | Assessment | Privacy Concerns |
|-------|-----------|-----------------|
| MVP (single user) | GREEN | Single user, simple consent. PII scrubbing + data minimization cover basics. |
| Growth (multi-user) | YELLOW | Per-user consent tracking and isolation become critical. Cross-user data leakage must be prevented. |
| Scale (enterprise) | ORANGE | DPIA required per deployment. Multi-jurisdiction PII definitions. Data residency requirements. Audit export needs. |
| Viral spike | GREEN | Privacy controls don't degrade under load — they're structural, not throughput-dependent. |

---

## Score: 7.5/10

**Justification**: Significant improvement from Round 1 (was 6/10). The three P0 issues (transparency, data minimization, DPIA) are all substantially addressed. The data minimization matrix is exemplary — each reviewer gets only what it needs. PII scrubbing adds a concrete defense layer. The remaining concerns (Article 22 classification, complaint classifier privacy) are real regulatory considerations but are addressable with disclosure additions rather than architectural changes. The information boundary rule is a privacy innovation that goes beyond compliance into proactive data protection.

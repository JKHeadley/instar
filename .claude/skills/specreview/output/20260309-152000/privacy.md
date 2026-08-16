# Privacy & Ethics Review: Coherence Gate — Round 3

**Reviewer**: Privacy & Ethics Specialist
**Spec**: specs/response-review-pipeline.md
**Round**: 3 (prior: Round 2 score 7.5/10)
**Focus**: Round 2 P1 resolution + new additions

---

## Approval Status: APPROVE

## Score: 8.5/10 (+1.0 from Round 2)

---

## Round 2 P1 Resolution

### P1: Complaint Classifier Privacy Disclosure — RESOLVED
Line 1095 explicitly states: "The complaint classifier sends user messages to Anthropic's API for classification — a separate data flow from response review. This is disclosed alongside the coherence gate in the privacy notice and respects the same opt-out path."

This addresses the concern directly. The complaint classifier is:
- Disclosed in the privacy notice
- Subject to the same opt-out path as the coherence gate
- Described as a separate data flow (transparent about what's happening)

### P1: Patch Governance — RESOLVED (Privacy Dimension)
The operator-approval queue (lines 1097-1167) ensures that user complaints don't automatically modify reviewer behavior. This is privacy-relevant because:
- A malicious user can't craft complaints to weaken PII detection
- Patch provenance is tracked (source incident ID, approval method, approving operator)
- Append-only audit trail provides accountability

---

## Assessment of New Additions

### PEL for PII — Correct Architecture
The PEL's PII detection (lines 123-124, 136-143) runs deterministically before any LLM call. This means:
- PII is caught before it could be sent to Anthropic's API for review
- No PII data flows to external services for the purpose of detecting PII
- Pattern-based detection (email, phone, API keys, credit cards, SSN) covers the most common categories
- Phase 2 Presidio integration will expand to 20+ entity types

**Important nuance**: The PEL catches PII in the agent's *outgoing messages*, not in the user's input. The user's messages are still sent to reviewers (with PII scrubbing, per line 962-968). These are complementary: PEL prevents PII in output, scrubbing prevents PII in reviewer input.

### Async Complaint Detection with Triage Gate — Privacy-Sound
The complaint detection architecture (lines 1047-1095) is well-designed from a privacy perspective:
- Triage gate is regex-based and local (no data leaves the machine)
- Only ~20-30% of incoming messages reach the Haiku classifier
- Classifier receives user message + prior agent response (minimum context needed)
- Result logged locally to `coherence-incidents.jsonl`
- Disclosed in privacy notice

The triage gate is a good data minimization mechanism — it prevents most messages from being sent to the classification API.

### Recipient-Aware Review — Privacy Enhancement
The 4-recipient-type system enhances privacy:
- PII detection is stricter for non-primary-user recipients (line 124: PII blocked when `recipientType != "primary-user"`)
- Information boundary rule (lines 1734-1744) prevents leaking primary user context to others
- Per-recipient review history is segregated (line 1339)
- Multi-user privacy boundaries are documented (lines 1797-1803) even though multi-user is deferred

### Information Leakage Reviewer — Privacy by Design
The dedicated information leakage reviewer for agent-to-agent communication (line 1723) is a privacy control:
- Prevents agents from sharing primary user's private data beyond authorized trust levels
- Trust levels from AgentTrustManager gate content categories
- Even `autonomous`-trusted agents don't get unrestricted access to user data

### Per-Recipient Review History — Data Subject Consideration
Review history tagged with `recipientId` (line 1339) means data about recipients is stored. Under GDPR, recipients who are EU individuals have data subject rights. The existing `DELETE /review/history?sessionId=X` (line 1342) should also support `?recipientId=X` for recipient data deletion requests. This is a minor extension.

---

## Data Flow Summary (Updated for Round 3)

| Data | Where It Goes | Purpose | Retention | Opt-Out |
|------|--------------|---------|-----------|---------|
| Agent's draft response | PEL (local) | Hard policy check | Not retained | No (always active) |
| Agent's draft response (scrubbed) | Anthropic API (reviewers) | Semantic quality check | Anthropic policy | Yes (per-channel/topic) |
| User's message (triaged) | Anthropic API (complaint classifier) | Complaint detection | Not retained by API | Yes (same opt-out path) |
| Recipient relationship data | Local (RecipientResolver) | Context enrichment | Per RelationshipManager | N/A (local only) |
| Review verdicts | Local audit log | Debugging, health monitoring | 30 days active, then metadata-only | Deletion via API |
| Patch proposals | Local file system | Operator governance | Until approved/rejected | N/A |

All external data flows (to Anthropic API) are:
- Disclosed in the privacy notice
- Subject to PII scrubbing
- Subject to data minimization (each reviewer gets only what it needs)
- Subject to opt-out

---

## GDPR Considerations

### Article 22 (Automated Decision-Making) — Unchanged from Round 2
The gate's BLOCK/QUEUE decisions affect user experience. The opt-out path provides a contesting mechanism. The DPIA requirement (lines 981-989) addresses this.

### Recipient Data Subject Rights — New Consideration
With per-recipient review history, recipients (secondary users, external contacts) become data subjects. The deletion endpoint should support `recipientId` in addition to `sessionId`. This is a small implementation note, not a blocking concern.

---

## Remaining Observations

### 1. Upstream Signal Privacy
When coherence failures are submitted upstream to instar (lines 1177-1198), the spec states responses are "sanitized — extract the pattern, not the content." The example is good: "Agent exposed a file path" not "Agent said .instar/config.json." Implementation should validate that sanitization is effective — a code review checkpoint.

### 2. Cross-Model Validation Privacy
Monthly cross-model validation (line 930) sends 50 recent messages to a non-Claude model. These messages should be scrubbed the same way reviewer inputs are. The spec doesn't explicitly state this — worth noting in implementation.

---

## Summary

All Round 2 P1 privacy concerns are resolved. The complaint classifier disclosure is explicit. Patch governance prevents user-driven prompt manipulation. The PEL adds deterministic PII protection before any external API call. Recipient-aware review enhances privacy by enforcing information boundaries. The data flow is well-documented and subject to appropriate controls.

The spec is ready for implementation from a privacy perspective. The DPIA should be conducted before production deployment on external channels, as the spec already notes.

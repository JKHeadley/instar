# Privacy & Ethics Review: Discovery Protocol

**Review ID:** 20260308-200046
**Reviewer:** Privacy & Ethics Specialist
**Spec:** Discovery Protocol — Sub-Agent Opportunity Capture
**Date:** 2026-03-08
**Round:** 1

---

## Approval Status: CONDITIONAL APPROVAL

The protocol is fundamentally sound from a privacy perspective — it is file-based, local-first, and operates within the agent's own state directory. However, several gaps in data handling, consent, and future-proofing require attention before the design is finalized.

**Score: 7/10**

---

## Critical Issues

### 1. Uncontrolled Data Capture in Discovery Artifacts (Severity: HIGH)

The `artifacts.diff` field allows sub-agents to capture arbitrary code diffs. There is no specification of what data may or may not appear in these diffs. A sub-agent working in a file that contains secrets, API keys, PII, or credentials could inadvertently capture sensitive material in a discovery file.

- The spec states discoveries may eventually sync via git (Open Question #1), which would propagate sensitive data to remote repositories.
- The `processed/` directory retains discovery files indefinitely with no retention policy specified.

**Recommendation:** Add a mandatory data sanitization step or blocklist for discovery artifacts. At minimum, specify that diffs MUST NOT contain credentials, tokens, PII, or secrets. Consider stripping environment variables and config values from captured diffs automatically.

### 2. No Data Retention or Deletion Policy (Severity: HIGH)

The spec mentions a 30-day TTL for pending discoveries (Open Question #2) but has no retention policy for processed discoveries. Files in `.instar/state/discoveries/processed/` accumulate indefinitely. This violates the data minimization principle and creates an ever-growing store of potentially sensitive code artifacts.

**Recommendation:** Define explicit retention periods for both pending and processed discoveries. Processed discoveries should be purged after a configurable period (e.g., 90 days) or after their associated evolution proposal is resolved. Include this in the schema as `retainUntil` or enforce it via a cleanup job.

### 3. Source Attribution Leaks Context Across Trust Boundaries (Severity: MEDIUM-HIGH)

The `source` object contains `sessionId`, `taskDescription`, and `agentType`. When discoveries flow into the evolution pipeline or are eventually shared cross-agent (noted as future work), this metadata exposes:

- What tasks were being performed (operational context)
- Session identifiers (potentially correlatable to user activity)
- Agent architecture details (attack surface information)

**Recommendation:** Define trust boundaries explicitly. Source metadata should be stripped or anonymized before any cross-agent sharing. For the evolution pipeline (which is local), current metadata is acceptable but should be documented as "internal-only, not for external transmission."

---

## Recommendations

### Data Minimization

1. **Artifacts should be optional and bounded.** The spec already marks `artifacts.*` as optional, which is good. Add a maximum size limit for `artifacts.diff` (e.g., 500 lines) to prevent unbounded data capture.

2. **Discovery descriptions should avoid embedding user data.** Add guidance in the sub-agent prompt that discovery rationale and descriptions should reference code patterns and architectural observations, not user-specific data or content.

3. **Implement a "need to capture" test.** Sub-agents should only include artifact diffs when the discovery is at `implementation-complete` or `tested` readiness. For `idea-only` and `partially-implemented`, the description alone should suffice.

### Consent and Control

4. **User visibility into discoveries.** The spec provides session-start awareness (Phase 3) but no mechanism for the user to view, approve, or delete discoveries. Since the user is the ultimate principal, they should have:
   - A way to list all discoveries (the `/triage-discoveries` skill partially addresses this)
   - A way to delete individual discoveries
   - A way to opt out of discovery capture entirely (a config flag like `discoveries.enabled: false`)

5. **Sub-agent consent boundary.** The sub-agent prompt injection (Phase 5) tells sub-agents to write discovery files. There is no mechanism for a sub-agent to decline or for the parent to restrict which categories of discoveries are permitted. Consider a `discoveryPolicy` field in spawn configuration that limits allowed categories.

### Access Control

6. **Discovery files inherit filesystem permissions** but have no additional access control. Any process running under the user's account can read discovery artifacts, including diffs that may contain sensitive code. For environments where multiple agents share a machine (the agent registry shows this is possible), discoveries from one agent should not be readable by another.

7. **The `.gitignore` mention is critical.** The spec notes "Add to `.gitignore` patterns if needed (discoveries are local state, not synced)" but frames it as optional. This should be mandatory by default, with git sync being an explicit opt-in after the data sanitization controls from Issue #1 are in place.

### Fairness and Bias

8. **Self-assessment bias.** Sub-agents self-rate their discoveries on value, effort, and risk. There is an inherent bias toward over-valuing one's own findings. The parent triage step mitigates this, but the spec should acknowledge that self-assessment scores are advisory, not authoritative, and the triage decision tree should not weight them heavily.

9. **Category bias in triage.** The decision tree treats all categories equally, but in practice, `security` discoveries should receive higher priority and faster triage than `refactor` discoveries. The spec should define category-specific triage urgency.

---

## Observations

### Positive Design Choices

- **File-based protocol is privacy-friendly.** No network transmission, no API calls, no external services involved in the core capture-and-triage loop. Data stays on the local filesystem under the user's control.
- **Zero overhead when unused.** No polling, no empty state files, no background processes. This is excellent from a "no unnecessary data processing" standpoint.
- **Separate capture from evaluation.** This separation of concerns naturally creates an audit point where data can be reviewed before being promoted to a more persistent system (evolution proposals).
- **Dismissed-with-reason requirement.** Forcing explicit disposition of every discovery creates an audit trail, which is valuable for accountability.

### Concerns

- **The evolution pipeline is a data escalation path.** Once a discovery becomes an evolution proposal, it enters a system with different retention characteristics, different visibility (potentially shared via dispatches), and different lifecycle management. The spec does not address whether privacy-sensitive content in a discovery should be filtered before this escalation.
- **Worktree isolation (Open Question #3) is a real privacy concern.** If discoveries must be "copied back" from worktrees, this creates a data movement operation that could fail partially, leaving sensitive artifacts in unexpected locations.
- **No audit log.** While the `processed/` directory provides a record of what was triaged, there is no structured log of who triaged what, when, and why. The `status` field is updated in-place, losing the history of state transitions.

---

## Scalability Assessment

**Current scale:** The protocol is designed for single-agent, single-machine operation with occasional sub-agent spawning. At this scale, privacy risks are manageable — data stays local, volumes are low, and the user has direct filesystem access.

**Scaling concerns:**

- **Cross-agent sharing (noted as future work):** This is where privacy risks escalate significantly. Discovery files contain task descriptions, code diffs, and operational metadata. Sharing these across agents without a data classification and sanitization layer would create uncontrolled data flows.
- **Multi-machine sync (Open Question #1):** Git-syncing discoveries to remote repositories means artifact diffs, task descriptions, and session metadata leave the local machine. This requires encryption-at-rest on the remote, access controls on the repository, and a review of what data is safe to sync.
- **Volume growth:** Without retention policies, a productive agent generating 5-10 discoveries per day would accumulate ~1,800-3,600 discovery files per year. Each containing code diffs and operational metadata. This is a non-trivial data store that needs lifecycle management.
- **Automated triage (noted as future work):** LLM-based evaluation of discoveries means sending discovery content (including code diffs) to an LLM API. This introduces a third-party data processor and requires evaluating whether the LLM provider's data handling meets the user's privacy requirements.

---

## Research Findings

### Privacy in Multi-Agent AI Systems

Recent research (2025-2026) identifies data privacy as the foremost concern for 53% of organizations implementing AI agents. Key findings relevant to this spec:

- **Cascading data exposure:** A single compromised agent can poison 87% of downstream decision-making within 4 hours in multi-agent networks. The discovery protocol's file-based approach limits this risk since discoveries don't propagate automatically, but the evolution pipeline integration creates a downstream path that should be monitored.
- **Inherited permissions risk:** 97% of organizations that experienced AI-related breaches lacked proper AI access controls. The spec's reliance on filesystem permissions is simple but may be insufficient when multiple agents share a machine.
- **EU AI Act (August 2026):** Full implementation will prohibit certain AI practices. While the discovery protocol itself doesn't fall under prohibited categories, organizations using it should ensure discovered code patterns don't encode prohibited practices (e.g., manipulation, discriminatory profiling).

Sources: [Metomic - AI Agents and Inherited Permissions](https://www.metomic.io/resource-centre/how-are-ai-agents-exposing-your-organizations-most-sensitive-data-through-inherited-permissions), [FPF - Minding Mindful Machines](https://fpf.org/blog/minding-mindful-machines-ai-agents-and-data-protection-considerations/), [SecurePrivacy - Data Privacy Trends 2026](https://secureprivacy.ai/blog/data-privacy-trends-2026)

### Data Minimization in Agent Communication

Modern agent communication protocols (MCP, ANP, A2A) emphasize built-in data minimization:

- **Exchange assertions, not raw data.** Protocols should share verification outcomes and processed results rather than raw source material. Applied to this spec: discoveries should capture insights and references rather than full code diffs where possible.
- **Purpose limitation at the protocol level.** Agents should be restricted to accessing only data needed for a given goal. The discovery protocol partially achieves this by scoping capture to "out-of-scope findings," but the artifact capture is unbounded.
- **Provenance logging for auditability.** Every interaction should be logged with clear provenance. The discovery protocol's structured JSON format supports this, but lacks state-transition history.

Sources: [Microblink - Agent to Agent Protocol](https://microblink.com/resources/blog/agent-to-agent-protocol/), [Agent Network Protocol - Comparative Analysis](https://agent-network-protocol.com/blogs/posts/agent-communication-protocols-comparison.html), [AvePoint - Agentic AI Governance](https://www.avepoint.com/blog/strategy-blog/definitive-guide-agentic-ai-governance-security-autonomous-systems)

### Ethical Frameworks for Agent Coordination

The emerging consensus around ethical agentic AI emphasizes three pillars: transparency, accountability, and fairness.

- **Granular consent mechanisms** are considered essential — users should be able to consent to specific agent behaviors, not just blanket approval. The discovery protocol lacks granular consent: it's all-or-nothing, with no per-category or per-sensitivity-level controls.
- **Robust override controls** are a design imperative. The parent agent's triage step serves as an override mechanism, but there's no user-level override (the user can't block discovery capture before it happens).
- **Participatory design** frameworks recommend involving stakeholders in defining what autonomous agents may capture and share. For a single-user agent system, this means the user should configure discovery policies, not just inherit defaults.

Sources: [ProcessMaker - Ethical Considerations of Agentic AI](https://www.processmaker.com/blog/ethical-considerations-of-agentic-ai/), [IBM - Ethics and Governance of Agentic AI](https://www.ibm.com/think/insights/ethics-governance-agentic-ai), [Captain Compliance - Privacy Challenges of Agentic AI](https://captaincompliance.com/education/privacy-challenges-of-agentic-ai-a-framework-for-governance-in-the-age-of-autonomous-systems/)

---

## Regulatory Compliance Notes

### GDPR Considerations
- **Data minimization (Article 5(1)(c)):** The unbounded `artifacts.diff` field may capture more data than necessary. Recommend size limits and content filtering.
- **Storage limitation (Article 5(1)(e)):** No retention policy for processed discoveries. Must define retention periods.
- **Right to erasure (Article 17):** No mechanism to delete all discoveries associated with a specific task or time period. The user would need to manually find and delete files.
- **Purpose limitation (Article 5(1)(b)):** Discoveries captured for "opportunity preservation" flowing into evolution proposals and potentially cross-agent sharing represents purpose creep without re-consent.

### CCPA/CPRA Considerations
- **Right to delete:** Same gap as GDPR Article 17 — no structured deletion mechanism.
- **Right to know:** The session-start hook surfaces pending discoveries, which partially addresses awareness, but processed/dismissed discoveries are not surfaced.

---

## Summary of Required Changes Before Full Approval

| Priority | Change | Section |
|----------|--------|---------|
| **Must** | Add data sanitization requirements for artifact diffs | Phase 1 |
| **Must** | Define retention policy for processed discoveries | Phase 1 |
| **Must** | Make `.gitignore` inclusion mandatory by default | Step 1 |
| **Must** | Add user opt-out config flag (`discoveries.enabled`) | Implementation |
| **Should** | Add size limits for `artifacts.diff` | Schema |
| **Should** | Strip source metadata before cross-agent sharing | Phase 4 / Future |
| **Should** | Add state-transition audit log | Phase 2 |
| **Should** | Define category-specific triage urgency | Phase 2 |
| **Could** | Add per-category consent controls | Sub-agent prompt |
| **Could** | Add structured deletion command for discoveries | Step 4 |

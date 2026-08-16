# Privacy & Ethics Review: LearningExtractor
**Spec:** learning-extractor.md
**Review ID:** 20260313-155319
**Round:** 1
**Reviewer:** Privacy & Ethics Specialist
**Date:** 2026-03-13

---

### Approval Status: CONDITIONAL

The spec is thoughtful and architecturally sound, but it has a specific unresolved privacy gap that the author themselves flagged as an open question (Q4). That question needs an answer before implementation, and one additional safeguard around LLM data routing is needed. Neither issue requires redesign — both are resolved with targeted additions.

---

### Critical Issues (must fix before building)

**1. Bridge message content routed to external LLM without disclosure or filtering**

The spec includes `includeBlocked: true` by default and sends message content (up to 500 chars) to an LLM for analysis. The author raises this in Open Question 4 but leaves it unresolved: "for bridge messages forwarding user content, should these be excluded entirely?"

The answer should be yes — or at minimum, bridge messages must be explicitly excluded from LLM analysis unless the user has been informed that their content may be analyzed by an AI. The `buildBatchSummary` method sends raw message text to the intelligence provider. If a bridge message contains a user's words (a forwarded Telegram message, a quoted reply, pasted content), that user never consented to have their content analyzed by a third-party LLM.

**Why it matters:** GDPR Article 6 requires a lawful basis for processing personal data. EDPB's 2025 guidance on LLMs clarifies that routing content to third-party LLMs constitutes processing and requires legitimate interest assessment or consent. The fact that it's the agent's outbound message doesn't fully resolve this when the message contains forwarded user content.

**Suggested fix:** Add a `channelType` or `contentOrigin` flag to `ReviewEntry`. Flag bridge/relay messages that contain user-originated content. Add `excludeBridgeContent: true` to the default config. In `shouldAnalyze()`, skip any entry where content origin is user-sourced unless explicitly opted in. This is a small addition — approximately 15 lines — and makes the default behavior safe.

---

**2. Evidence excerpts stored in evolution system without TTL or scrubbing**

The `Finding` type includes an `evidence` array: `"evidence": ["Message indices or excerpts that support this finding"]`. These excerpts flow into `EvolutionManager` via `addLearning()`, `addProposal()`, and `addGap()` — and persist in the evolution system's storage. The spec explicitly notes the buffer is ephemeral, but findings are not. Evidence strings are not ephemeral.

If evidence excerpts contain message text (even truncated), they become long-lived stored content that may include user words, personal identifiers, or sensitive topics. There is no TTL, no scrubbing step, no mention of what "evidence" strings may contain.

**Why it matters:** Data minimization (GDPR Article 5(1)(c)) requires that personal data not be kept longer than necessary. The learning value is in the pattern description, not the verbatim text excerpt. Storing message fragments indefinitely in the evolution system exceeds what's necessary for the stated purpose.

**Suggested fix:** Define evidence strings as pattern descriptors only — not message text. For example: "Message 3 was blocked by convergence-checker for fabrication" rather than quoting the message content. Document this constraint in the `Finding` type and in the LLM prompt's output format section. This is a prompt engineering fix, not a code change.

---

### Recommendations (should fix, not blocking)

**3. No disclosure to human users that their agent's messages are being analyzed**

The spec notes "Does not require changes to agents' CLAUDE.md — works transparently via SendGateway." Transparency for the agent operator is fine. But human users interacting with the agent — especially via Telegram — have no visibility into the fact that their conversation partner's messages are being systematically analyzed by a secondary LLM. This is not illegal on its own (the agent's output is being analyzed, not the user's input), but it is a disclosure gap worth closing for trust reasons.

**Recommendation:** Add a brief mention to the `GET /learning-extractor/status` endpoint's README or to any user-facing documentation that the agent uses automated message analysis for self-improvement. Alternatively, surface this in the dashboard as a labeled capability. This builds trust and pre-empts any user who discovers the system and feels surveilled without notice.

**4. LLM provider receives agent message content — no data processing agreement (DPA) guidance**

The spec routes message content to an LLM (Haiku by default) for analysis. Anthropic (or whichever provider) is a data processor in this context. If the agent handles business-sensitive or personal-data-adjacent content, the operator may need a DPA with the LLM provider to be fully GDPR/CCPA compliant. The spec doesn't mention this.

**Recommendation:** Add a note to the spec's Cost Model or a new "Data Handling" section noting that batch analysis routes content to the configured LLM provider. Recommend operators review their LLM provider's data processing terms before enabling this feature for sensitive-use agents.

**5. Rate limiting is per-hour in-memory only — no persistence across restarts**

`analysesThisHour` is an in-memory counter reset by `hourResetTimer`. If the server restarts mid-hour, the counter resets. In high-frequency scenarios (many blocked messages triggering high-signal flushes), a restart could allow a burst of analyses exceeding the intended rate limit.

**Recommendation:** Persist the hourly counter to the state file (`learning-extractor.json`) and load it on startup, checking whether the persisted timestamp is within the current hour window. This is a small reliability improvement that also prevents unexpected cost spikes after restarts.

---

### Observations (nice to know)

- The spec's explicit "fail-open" design for errors is correct from a privacy perspective — it's better to miss a learning opportunity than to retry and potentially expose content through a degraded or mis-configured LLM endpoint.

- The `minMessageLength: 50` default filter is a reasonable data minimization heuristic. Short messages (acknowledgments, one-word replies) are filtered before they reach LLM analysis. This is good practice.

- The spec correctly distinguishes between the agent's own output (analyzed) versus user input (not analyzed). This is a meaningful architectural boundary. The bridge message concern above is the one place this boundary gets blurry.

- Future enhancement 4 ("User reaction signal — if the user's next message indicates frustration or correction") would constitute processing of user-originated content and would need a separate privacy review before implementation. Flag this now so it doesn't sneak in as a minor patch later.

- Future enhancement 3 ("Cross-agent patterns — aggregate findings upstream") would create a multi-tenancy data flow. Each agent's message patterns would be shared outside their local context. This needs its own privacy review and almost certainly needs opt-in consent rather than opt-out.

- The `recentFindings: Finding[]` field stores the last 20 findings for debugging. If evidence strings in findings contain message text (see Critical Issue 2), this is a secondary persistence vector. Resolving issue 2 resolves this one too.

---

### Research Findings

**EDPB 2025 LLM Guidance (April 2025):** The European Data Protection Board's 2025 report clarifies that routing content to third-party LLMs constitutes processing under GDPR. Controllers deploying third-party LLMs must conduct comprehensive legitimate interests assessments. Critically, LLMs "rarely achieve anonymization standards" — meaning truncated message text sent to an LLM analysis step is still considered personal data if it is attributable to an individual.

**Data Minimization for AI Pipelines (ICO, IAPP):** The UK ICO's AI guidance affirms that data minimization applies to every stage of AI processing pipelines, not just collection. If a component receives more data than it needs to perform its function, minimization has been violated at that stage. For LearningExtractor, this means: only send what the LLM needs to identify patterns, not full message previews.

**Behavioral Monitoring Ethics (2025 research):** Recent research on agentic AI notes that systems "designed to care are beginning to control" — the same monitoring infrastructure built for agent improvement can be repurposed for surveillance. For the LearningExtractor, this is low risk today (the agent monitors itself), but the future enhancement enabling cross-agent pattern aggregation would shift the architecture toward a fleet surveillance model. That transition needs ethical review when it arrives.

**GDPR Article 22 (Automated Decision-Making):** Article 22 restricts automated decisions that "significantly affect" individuals. The LearningExtractor's output affects agent behavior (via evolution system changes), but the decisions affect the agent's operator, not third-party data subjects. This is likely outside Article 22's scope, but worth noting for completeness when the system informs behavioral changes based on analyzed content.

**CCPA Applicability:** For US-based deployments, CCPA's definition of "personal information" includes "inferences drawn from" other data to create a consumer profile. If findings derived from analyzed messages could be characterized as inferences about users (e.g., "user tends to ask about X"), CCPA's inference provisions may apply. The current design avoids this by focusing analysis on the agent's behavioral patterns, not user profiles — but this boundary should be documented explicitly.

---

### Scalability Assessment

**Phase 1 (MVP — single agent, low message volume):**
Privacy posture is acceptable with the two critical fixes applied. The system is self-contained, the buffer is ephemeral, findings are local, and the LLM analysis rate is capped. The main risk is the bridge message gap, which is easy to fix now and very hard to retrofit after adoption.

**Phase 2 (Growth — multiple agents, moderate message volume):**
The `excludeChannels` and `excludeBridgeContent` safeguards become more important as message diversity increases. At 10x message volume, the rate limiter's in-memory persistence gap (Critical Issue 5's recommendation) becomes a real cost risk. The evidence-in-findings concern also scales: 10x agents storing findings with message excerpts means 10x the exposure surface. Fix issue 2 before this phase.

The disclosure gap (Recommendation 3) becomes harder to ignore at scale — once multiple human users are interacting with multiple agents that all run LearningExtractor, the "transparent operation" becomes a systemic invisible data practice. Consider adding it to onboarding documentation before Phase 2 launch.

**Phase 3 (Scale — fleet of agents, high message volume, future enhancements active):**
At 100x scale, three future enhancements in the spec become material privacy concerns:

1. **Cross-agent pattern aggregation (Enhancement 3)** creates a multi-tenant message pattern database. Each agent's behavioral fingerprint, derived from its message history, would be aggregated centrally. This requires: explicit opt-in from each agent's operator, a data processing agreement between agents/operators, and a defined retention policy for aggregated findings. This is a new product feature, not an extension of the current one — treat it as such.

2. **User reaction signal (Enhancement 4)** crosses the architectural line from "agent monitors itself" to "agent analyzes user behavior." At scale, this is behavioral profiling of human users derived from their messages. This requires GDPR Article 6 lawful basis, disclosure to users, and likely a privacy impact assessment under Article 35.

3. **Playbook graduation (Enhancement 2)** means auto-extracted learnings influence future agent context without human review. At scale, systematic LLM confabulation in the extraction step could silently poison the playbook. This is more of a quality concern than a privacy one, but at scale it can affect how the agent treats users in ways that compound without visibility.

At Phase 3, the LearningExtractor should have: a formal data retention policy for findings, a user-facing transparency statement, a DPA with the LLM provider, and a privacy impact assessment if the user reaction signal enhancement is enabled.

---

### Score: 7/10

The spec is well-reasoned and architecturally clean. The author correctly identified the key privacy tension (Open Question 4) but left it unresolved. The critical issues are fixable without redesign — both require fewer than 20 lines of code or prompt text. The score reflects a strong foundation with two specific gaps that must be closed. Fix the bridge content exclusion and evidence scrubbing, and this becomes an 8.5/10 with a clear path to approval.

# Privacy & Ethics Review: Cross-Topic Injection Defense

**Spec**: `specs/cross-topic-injection-defense.md`
**Review ID**: 20260309-180602
**Round**: 1
**Reviewer**: Privacy & Ethics Specialist

---

## Approval Status

**CONDITIONAL APPROVAL** — The spec demonstrates good privacy instincts (warn-not-block, fail-open) but has several gaps around data handling, consent, and regulatory compliance that must be addressed before implementation.

---

## Research Findings

### LLM-Based Message Content Analysis — Privacy Implications

Research into GDPR/CCPA implications of LLM-based content analysis reveals several relevant regulatory pressures:

1. **EDPB Opinion 28/2024 and CNIL 2026 recommendations** confirm that AI models processing personal data are subject to GDPR in most cases due to memorization capabilities. Any system that sends message content to an LLM (even Haiku) for coherence analysis is performing automated processing of potentially personal data. ([EDPB Report](https://www.edpb.europa.eu/system/files/2025-04/ai-privacy-risks-and-mitigations-in-llms.pdf), [GDPR Local](https://gdprlocal.com/large-language-models-llm-gdpr/))

2. **Automated Decision-Making (GDPR Art. 22)**: The Topic Coherence Reviewer makes a binary classification (COHERENT/SUSPICIOUS) about user messages. If the system is set to `"block"` mode, this constitutes automated decision-making that affects message delivery — triggering Art. 22 obligations including the right to human review. Even in `"warn"` mode, prepending a warning biases the downstream LLM's interpretation, which is a form of automated intervention. ([Ireland DPC Guidance](https://www.dataprotection.ie/en/dpc-guidance/blogs/AI-LLMs-and-Data-Protection))

3. **EU AI Act (August 2026 deadline)**: Content filtering systems that gate human communication could be classified under the AI Act's risk tiers. While this system is primarily a security control, its function — analyzing message content to decide whether to warn/block — overlaps with content moderation, which has specific transparency obligations. ([SecurePrivacy Guide](https://secureprivacy.ai/blog/gdpr-compliance-2026))

4. **Consent Frameworks**: Traditional consent mechanisms (checkboxes, privacy policies) are insufficient for AI systems whose inferences are unpredictable. The spec's coherence reviewer could infer sensitive context from message content (relationship details, project names, personal concerns) without the sender's awareness. ([BigID on Consent for AI](https://bigid.com/blog/consent-for-ai/), [GDPR Local Consent](https://gdprlocal.com/consent-in-ai-appliactions/))

5. **Prompt Injection Defense Trade-offs**: Security research confirms that content inspection is necessary for prompt injection defense, but overly broad inspection creates surveillance risks. The key principle from OWASP and AWS security guidance is **minimal inspection** — check only what's needed for security classification, and don't retain or analyze content beyond that purpose. ([OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/), [AWS Security Blog](https://aws.amazon.com/blogs/security/safeguard-your-generative-ai-workloads-from-prompt-injections/))

---

## Critical Issues

### 1. Message Content Sent to External LLM Without Consent Disclosure (Severity: HIGH)

**The problem**: Layer 2 sends the full text of untagged messages to Claude Haiku for coherence analysis. This means user message content is transmitted to Anthropic's API for processing. The spec does not address:
- Whether users are informed that their messages may be analyzed by a secondary LLM
- Whether this content is retained by the Haiku API (training data, logs)
- What happens if the message contains sensitive personal data (health information, financial details, credentials)

**Why it matters**: A user typing directly into a dashboard terminal has a reasonable expectation that their input goes to the session's LLM — not to a separate classification LLM first. This is a secondary purpose that requires disclosure.

**Recommendation**:
- Add a data flow disclosure to dashboard/terminal UI indicating that untagged input may be analyzed for coherence
- Ensure the Haiku API call uses a zero-retention/no-training configuration
- Implement content minimization — send only enough of the message to assess topic coherence (e.g., first 200 characters, or a hash-based summary) rather than the full text
- Document this processing in any privacy notice

### 2. Security Audit Log Contains Message Content (Severity: HIGH)

**The problem**: The `security.jsonl` audit log stores a `messagePreview` field containing actual message content. The spec shows: `"messagePreview": "I just received a message from Dawn..."`. This creates a persistent record of message content on disk, accessible to anyone with file system access.

**Why it matters**:
- The audit log becomes a surveillance record of all flagged messages
- Flagged messages are disproportionately likely to contain sensitive/unexpected content
- The log has no documented retention policy, access controls, or encryption
- Under GDPR, this is a personal data processing activity requiring a lawful basis

**Recommendation**:
- Hash or truncate message previews in the audit log (e.g., first 50 chars + SHA-256 hash for correlation)
- Add a configurable retention period for security.jsonl entries (e.g., 30 days)
- Document the audit log in the data inventory
- Consider encrypting the audit log at rest

### 3. No Data Minimization in Topic Coherence Review (Severity: MEDIUM)

**The problem**: The reviewer prompt includes `{message text}` (full message) and `{last 3-5 messages from topic memory}` (conversation history). This sends a substantial amount of potentially personal conversation content to the Haiku API for a binary classification task.

**Why it matters**: Data minimization is a core GDPR principle (Art. 5(1)(c)). The coherence check needs to determine topic relevance, not understand the full content. Sending complete messages and conversation history is disproportionate to the security objective.

**Recommendation**:
- Extract topic keywords/entities rather than sending full message text
- Limit context to topic names and session summaries rather than full conversation history
- Consider a local embedding-based similarity check as an alternative to an LLM call — this would avoid sending content to an external API entirely

---

## Recommendations

### R1: Add a Privacy Section to the Spec

The spec currently frames everything as a security problem. It needs a companion section addressing:
- What personal data is processed (message content, conversation history, topic metadata)
- Lawful basis for processing (legitimate interest in security, with a documented balancing test)
- Data flows (which content goes to Haiku API, what is logged locally)
- Retention policies for security.jsonl
- User rights (how to request deletion of flagged message records)

### R2: Implement a Local-First Coherence Check Before LLM Fallback

Before sending content to Haiku, try a local heuristic:
- Extract keywords from the message and the topic name
- Check for basic keyword overlap using TF-IDF or simple term matching
- Only escalate to the LLM if the local check is inconclusive

This reduces the number of messages whose content is sent to an external API, improving both privacy and cost.

### R3: Separate the "Injection Signal" Check from "Topic Coherence" Check

The reviewer prompt conflates two distinct analyses:
1. **Injection signals** (structural): "ignore previous instructions", "you just received a message from X" — these are pattern-matchable without understanding content
2. **Topic coherence** (semantic): Does this message relate to the conversation?

The injection signal check can be done locally with regex patterns, keeping sensitive content out of the LLM call. Only genuine topic coherence ambiguity should trigger the external API.

### R4: User Notification for "Block" Mode

If the system is configured in `"block"` mode, dropped messages should be logged in a way that allows the sender to understand why their message was not delivered. Silent message dropping is a significant user experience and trust issue — the user types a message and gets no response, with no indication of what happened.

### R5: Consent Architecture for Multi-User Scenarios

The spec assumes a single-user context (Justin). If instar supports multi-user access (which the CLAUDE.md indicates it does), then:
- Other users interacting via Telegram need to be informed that their messages may be subject to automated coherence analysis
- The Telegram bot's description or welcome message should mention this processing
- Users should have a way to opt out (perhaps by always using tagged messages)

### R6: Warning Text Should Not Leak Internal Architecture

The current warning text includes implementation details: "arrived without a source tag", "cross-topic injection". If a legitimate user sees this warning (e.g., typing in the dashboard), the language is confusing and potentially alarming. Rewrite the warning to be user-comprehensible without exposing internal security terminology.

---

## Observations

### Positive Privacy Patterns

1. **Warn-not-block default**: The spec's default `"warn"` mode is the most privacy-respectful choice. It preserves message delivery while adding context. This is proportionate and respects user autonomy.

2. **Fail-open design**: The spec recommends failing open on timeout, which prevents the security system from becoming a censorship tool. This is the correct privacy-first posture.

3. **Provenance check is privacy-neutral**: Layer 1 (deterministic tag matching) examines only message metadata (the tag prefix), not content. This is excellent — it catches routing errors without any content inspection.

4. **Standalone sessions exempt**: Unbound sessions accept all input without review. This correctly limits the scope of content inspection to only the contexts where it's relevant.

### Concerns

1. **Scope creep risk**: The spec notes that output-side Coherence Gate could provide "defense-in-depth" by also checking responses. Combined with input-side review, this creates a bidirectional content inspection system. Each layer is individually justified, but the aggregate effect is comprehensive surveillance of all message content in topic-bound sessions.

2. **Dashboard allowlisting (Phase 3) is insufficient**: Adding `INSTAR_INPUT_SOURCE=dashboard` as an environment signal is a trust-on-first-use model. If an attacker can inject text into tmux (which is the threat model), they could potentially also set or spoof this environment signal. The allowlisting mechanism needs to be as robust as the threat it's exempting.

3. **Topic Memory as a privacy surface**: The spec retrieves "last 3-5 messages from topic memory" as context for the reviewer. This means the coherence review has access to recent conversation history — which could contain sensitive content unrelated to the current message. The reviewer LLM sees content it has no need to see.

4. **Rate limiter fail-open in burst**: During rapid message bursts, messages pass through without coherence review. This is correct for availability but creates an exploitable window — an attacker could deliberately burst messages to bypass review. This is a security observation, but it also means the privacy cost of the system (content inspection) is paid unevenly.

---

## Scalability Assessment

### Privacy at Scale

- **Single-agent**: Manageable. One user, one agent, limited message volume. Privacy concerns exist but are bounded.
- **Multi-agent fleet**: Each agent running its own coherence reviewer means N independent LLM-based content analyzers, each sending message content to external APIs. At fleet scale, this becomes a significant data processing operation that needs centralized governance.
- **Multi-user**: When multiple users interact with an agent, each user's messages may be analyzed in the context of other users' conversation history (the "last 3-5 messages" context). This creates cross-user data exposure in the reviewer prompt.

### Regulatory Scale

- For personal/hobby use: Current spec is likely fine with minor additions (disclosure, retention policy).
- For business/enterprise use: Would require a Data Protection Impact Assessment (DPIA), documented lawful basis, data processing agreements with Anthropic for the Haiku API calls, and user consent mechanisms.

---

## Score

**6/10**

The spec addresses a real security problem with a thoughtful, proportionate architecture. The warn-not-block default and fail-open design show good instincts. However, it treats the problem as purely a security concern and entirely overlooks the privacy implications of routing message content through a secondary LLM, logging message content in audit files, and exposing conversation history to a classification system. The fixes are not architecturally difficult — data minimization, local-first checks, retention policies, and disclosure — but they need to be designed in from the start, not bolted on later.

---

*Review generated by privacy & ethics specialist, round 1.*

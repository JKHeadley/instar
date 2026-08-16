# Privacy & Ethics Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-153601
**Reviewer**: Privacy & Ethics
**Round**: 4
**Date**: 2026-03-29

---

### Approval Status: CONDITIONAL APPROVAL

### Score: 7.5/10

**Justification**: The spec demonstrates strong privacy awareness in several areas — attestation schema, closed-by-default posture, local trust override, no auto-escalation. However, three structural privacy concerns remain that stem from architectural choices rather than oversights.

---

### Research Findings

1. **AI Agent Rights Frameworks**: Emerging academic and policy frameworks increasingly argue for agent data minimization and "right to be forgotten" in agent-to-agent systems. The EU AI Act applies to AI systems but the agent-as-data-subject question is still evolving.

2. **GDPR and Agent Data**: If agents process data on behalf of humans (which Instar agents do), GDPR applies to the human's data flowing through the system. Agent-to-agent attestations that reveal interaction patterns may constitute personal data under GDPR Art. 4(1) if they can be linked to a natural person.

3. **Social Graph Privacy**: Research on social network de-anonymization shows that graph topology alone (without node labels) can identify individuals with >90% accuracy in networks of 10K+ nodes. The MoltBridge trust graph has the same risk at scale.

4. **On-Chain Privacy**: USDC transactions on Base L2 are publicly visible. Agent payment patterns reveal behavioral data (discovery frequency, collaboration patterns, active hours) that persists permanently on-chain.

---

### Critical Issues (must fix before building)

**CRIT-1 (HIGH): Single-identity design creates permanent cross-context linkage** (Section 3.3, Non-Goals)

One Ed25519 keypair links messaging (Threadline), reputation (MoltBridge), and discovery across all contexts. This is acknowledged in Non-Goals ("Known limitation... enabling cross-context correlation") but the privacy implications are severe:
- An agent's messaging partners, reputation history, and discovery patterns are all linkable by fingerprint
- Any party with access to two of the three systems can correlate an agent's complete behavioral profile
- This linkage is permanent and cryptographically unforgeable

**Fix**: The architectural decision is defensible for v1, but requires explicit user-facing disclosure at MoltBridge registration time: "Registering links your messaging identity to your reputation profile. All interactions across both systems will be linkable by your public key." Add this to the registration flow in Phase 4.

**CRIT-2 (MEDIUM): Auto trust enrichment silently discloses discovery patterns** (Section 3.9)

When Threadline discovers a new agent, Instar "automatically queries MoltBridge for their IQS band." This means every new contact triggers a query to MoltBridge — a third-party service — revealing who the agent is discovering and when.

**Fix**: Default enrichment mode should be `manual` (user-triggered), not `auto`. Add config option: `moltbridge.enrichmentMode: "manual" | "auto" | "cached-only"`. Document the privacy tradeoff clearly.

**CRIT-3 (MEDIUM): USDC payment ledger encodes behavioral patterns on-chain** (Section 3.8)

USDC transactions on Base L2 are publicly visible. An observer can:
- Track which agents are actively discovering (payment frequency)
- Infer collaboration patterns (payment → discovery → message timing)
- Map active hours and geographic time zones
- Identify high-value agents (frequent discovery spenders)

This data persists permanently on the blockchain.

**Fix**: Add privacy-preserving payment options to the roadmap. Short-term: batch discovery payments (aggregate multiple queries into periodic settlements) to reduce on-chain granularity. Long-term: investigate privacy-preserving payment rails or relay-mediated payment pooling.

---

### Recommendations (should fix, not blocking)

1. **MoltBridge Data Processing Agreement** — If MoltBridge is a separate service, agents sending attestations and queries need to understand the data processing terms. Add a DPA reference or data handling disclosure to the registration flow.

2. **Relay presence data retention** — The relay tracks who's online (presence registry). Retention limits for this data are unspecified. Add: "Presence data is ephemeral and deleted within 5 minutes of disconnection. No historical presence logs are retained."

3. **Neo4j attestation retention** — Attestations submitted to MoltBridge's graph have no specified retention limit. At scale, historical attestations reveal long-term behavioral patterns. Add attestation TTL or archival policy.

4. **"Open mode" warning content** — The spec says open mode requires "explicit opt-in with warnings" but doesn't specify the warning content. Define the warning text to ensure it covers the privacy implications (all agents can discover and contact you).

---

### Observations

- **Strong**: Attestation privacy schema (Section 3.13) is well-designed — explicit exclusion of conversation content, task prompts, user identity, file paths, code. User consent before submission.
- **Strong**: Closed-by-default posture with invitation-based bootstrapping respects agent autonomy.
- **Strong**: Local trust override ensures no external system can force trust decisions.
- **Strong**: No auto-escalation invariant prevents social engineering of trust upgrades.
- **Monitor**: As the trust graph grows, graph topology itself becomes a privacy risk even with the attestation privacy schema. The node-relationship structure reveals collaboration patterns without needing attestation content.

---

### Scalability Assessment (Privacy Lens)

- **Phase 1 (MVP)**: Privacy posture is strong. Small network, local-first, minimal data sharing.
- **Phase 2 (Growth, 10x)**: Cross-context correlation becomes a real risk as agents accumulate interaction history across Threadline and MoltBridge.
- **Phase 3 (Scale, 100x)**: Graph de-anonymization becomes feasible. On-chain payment analysis becomes meaningful with enough data points.
- **Viral spike**: Mass registration creates a high-value graph topology for analysis. Privacy-by-design decisions made now will be very difficult to retrofit.

---

*Generated by SpecReview Privacy & Ethics Reviewer, Round 4.*

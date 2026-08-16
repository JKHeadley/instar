# Privacy & Ethics Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-093126
**Reviewer**: Privacy & Ethics
**Date**: 2026-03-29
**Round**: 1

---

## Approval Status: CONDITIONAL

**DO NOT SHIP without resolving Critical Issues 1, 2, and 3.**

## Score: 5.5/10

**Justification**: The spec shows genuine privacy awareness at the transport layer (E2E encryption, closed-by-default posture, local trust precedence, no central identity provider). However, it is missing foundational data governance requirements that regulators will look for in 2026.

---

## Research Findings

1. **GDPR implications for AI agent data sharing (2025–2026)** — Spain's AEPD published a 71-page agentic AI analysis (Feb 2026); UK ICO published early views (Jan 2026). Both identify that agent-to-agent data flows not directly observable to humans create inherent tension with GDPR transparency requirements. The IAPP notes that purpose limitation must be re-evaluated per agent action, not just at onboarding.

2. **Privacy in agent-to-agent communication** — Auditing "conversations" between autonomous agents is fundamentally harder than auditing API calls because traditional logging misses contextual reasoning. Granular consent (per-action) is now the minimum bar per EDPB's April 2025 LLM guidance.

3. **Trust/reputation graph de-anonymization attacks** — Academic literature establishes that graph topology alone can re-identify nodes even without explicit labels. MoltBridge's Neo4j graph is specifically at risk: capability profiles + attestation links + interaction history create a rich fingerprinting surface.

4. **Consent models for autonomous agents** — California CPRA rules effective January 1, 2026 give consumers the right to opt out of Automated Decision-Making Technology (ADMT). MoltBridge's IQS score is precisely the kind of ADMT requiring an opt-out path. The fundamental open question: when an AI agent says "I agree," who is consenting?

---

## Critical Issues

### CRITICAL 1: No Data Minimization Policy for the Trust Graph (GDPR Article 5(1)(c))

The spec describes storing interaction history, circuit breaker state, trust level changes, cached IQS scores, peer attestations given and received, and behavioral history for trust decay. There is no statement of the minimum necessary data set, retention periods, or deletion triggers. The MoltBridge IQS formula relies on accumulated behavioral data with no defined lifecycle.

**Required**: Add a data inventory table. For each data category: what it is, why it's needed, retention period, and deletion path. Attestations are write-amplified — one agent attesting about another writes a record to MoltBridge infrastructure that the attested agent may not know about and cannot easily delete.

### CRITICAL 2: Agent Consent Is Not Human Consent (GDPR lawful basis gap; CCPA ADMT)

`POST /moltbridge/register` and `POST /moltbridge/attest` are initiated by the Instar agent, not the human user. `moltbridge.autoRegister: false` is a config flag, not a consent mechanism. Under California's 2026 CPRA rules, an opt-out mechanism is required for ADMT. Third-party attestations (Agent A attesting about Agent B) write records about Agent B without Agent B's human operator's consent.

**Required**: (1) Define GDPR lawful basis for each processing activity. (2) MoltBridge registration must be an explicit informed consent flow. (3) Third-party attestations must include a notification and challenge mechanism for the attested agent.

### CRITICAL 3: No Right to Deletion or Data Portability Path (GDPR Articles 17 and 20)

The revocation model covers trust levels and authorization grants — not data deletion. There is no defined path for a user to remove their agent from the MoltBridge graph entirely. With MoltBridge data in Neo4j on external infrastructure, GDPR Article 17 erasure is not trivially achieved by deleting local files.

**Required**: Add `DELETE /moltbridge/registration` to the API. Document what deletion removes vs. what it cannot remove (e.g., attestations given by others). Add a data portability export endpoint.

---

## Recommendations

| Priority | Recommendation | Phase |
|----------|---------------|-------|
| P0 | Data inventory table for all trust/attestation data | Phase 4 |
| P0 | GDPR lawful basis documentation | Phase 4 |
| P0 | Explicit consent flow for MoltBridge registration | Phase 4 |
| P0 | `DELETE /moltbridge/registration` endpoint | Phase 4 |
| P0 | Third-party attestation notification mechanism | Phase 4 |
| P1 | Privacy notice before first registration | Phase 4 |
| P1 | Per-attestation explicit user confirmation | Phase 5 |
| P1 | Rate-limit graph proximity queries | Phase 5 |
| P1 | Relay queue TTL and metadata retention policy | Phase 3 |
| P2 | Threadline directory opt-in | Phase 3 |
| P2 | IQS appeal/correction process | Phase 6 |
| P2 | USDC wallet address privacy analysis | Any |

---

## Observations

**Privacy-positive design choices**:
- XChaCha20-Poly1305 + X25519 ephemeral keys — correct baseline
- Local trust precedence over network scores — correct privacy principle
- Closed-by-default invitation posture — should be highlighted as a feature
- No central identity provider — eliminates a major privacy risk class
- No auto-escalation of trust — prevents consequential decisions without human involvement
- Short-lived 1-4h authorization grants — good privacy hygiene

**Structural concerns**:
- The spec treats privacy primarily as a security concern (encryption, trust) rather than a data governance concern (minimization, purpose limitation, user rights) — both are required
- USDC on Base L2 is permanently public and linkable; wallet addresses may link agent identity to human identity permanently
- "Founding agent incentive" creates financial pressure that could compromise the `autoRegister: false` default

---

## Scalability Assessment (Privacy Dimension)

| Scale | Assessment | Key Risks |
|-------|-----------|-----------|
| Small (tens of agents) | Manageable | Graph attacks less effective; attestation volume low |
| Medium (thousands) | Regulatory scrutiny increases | Trust graph becomes surveillance target; attestations accumulate into behavioral profiles |
| Large (millions) | Would not be compliant | Needs differential privacy for IQS, privacy-preserving federated graph, relay metadata minimization |

---

*Generated by SpecReview Privacy & Ethics Reviewer.*

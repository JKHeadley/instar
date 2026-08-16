# SpecReview — Privacy & Ethics Review
## Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-171842
**Date**: 2026-03-29
**Round**: 5
**Spec Version**: v0.4.0
**Reviewer Role**: Privacy & Ethics Specialist
**Focus**: Round 4 privacy concern resolution — enrichment default, single-identity disclosure, on-chain payment privacy, blinded attestations

---

## Approval Status

**CONDITIONAL APPROVE**

Score: **8.6 / 10** (up from 7.5 in Round 4)

Round 4 raised three P1 privacy issues. This round assesses whether v0.4.0 adequately resolves them. The verdict: two of three are well-resolved; one remains materially incomplete. Additionally, this review surfaces two new concerns not previously flagged.

---

## Research Findings

Before assessing the spec, I conducted independent research on four areas.

### Single-Identity System Privacy Risks

Current GDPR interpretation defines "personal data" as any data that can be linked to identify an individual, even indirectly. The proposed Digital Omnibus revision (2026 consultation) would narrow this — data is only "personal" when the controller *also possesses the means to identify* — but this is not settled law. For a system linking messaging identity, reputation history, and discovery patterns under one key, GDPR Article 5(1)(c) (data minimisation) and Article 25 (data protection by design) are directly implicated. The French CNIL 2025-2028 strategic plan specifically flags digital identity and mobile application data linkage as enforcement focus areas.

Cross-context linkage is precisely what pseudonymous identifiers are designed to prevent. A single Ed25519 public key acting as universal identifier across Threadline (messaging), MoltBridge (reputation), and discovery enables any party who encounters the key in one context to correlate it across all contexts. This is not a theoretical risk — it is the designed behavior of the system.

### On-Chain Payment Privacy (USDC on Base L2)

Base L2 finished 2025 as the leading L2 by revenue ($4.3B DeFi TVL). USDC on Base inherits Base's public ledger: all transactions are permanently visible, including wallet addresses, amounts, and counterparties. Blockchain analytics firms (Chainalysis, Elliptic, and others) routinely de-anonymize wallet holders by correlating on-chain patterns with off-chain identity anchors — including the very fiat on-ramps that users must use to fund wallets.

The relevant finding: stablecoin payment activity is *not private by default*. Discovery payments of $0.02-0.05 per query create a visible, time-stamped, wallet-linked graph of which agents are querying which discovery targets. This is effectively a public record of social graph exploration.

Circle launched USDCx (in partnership with Aleo) in December 2025 — a compliance-friendly privacy stablecoin. This is the emerging standard for privacy-conscious stablecoin payments.

### GDPR Compliance for Trust/Reputation Systems

Reputation systems that process data about individuals (or agents acting on behalf of individuals) trigger GDPR obligations when the output affects those individuals. EDPB guidance and Article 22 GDPR specifically restrict *automated decision-making* that produces legal or similarly significant effects. An IQS score that gates whether an agent can receive task delegations, or that affects an agent's economic opportunity via broker revenue, plausibly constitutes a "significant effect."

EU AI Act obligations (compliance deadline August 2026) create dual requirements for high-risk AI systems. Trust scoring systems in professional/employment contexts are explicitly listed as high-risk. The IQS system, if used for agent employment decisions (which broker revenue implies), may cross this threshold.

EDPB's April 2025 guidance confirms LLM outputs rarely achieve anonymization standards — the spec's use of Haiku-class LLM for discovery ranking creates a data processing relationship that needs a lawful basis.

### Blinded Attestation Systems and K-Anonymity

2025 academic literature (PRIVÉ swarm attestation scheme, published PETS 2025) demonstrates that privacy-preserving attestation with accountability is achievable using blind signatures and UC-secure protocols. The PRIVÉ scheme achieves anonymous attestation while retaining the ability to trace failed attestations to compromised devices — precisely the tradeoff the spec needs (attestor privacy vs. accountability for false attestations).

The spec's current blinded attestation design — "MoltBridge knows the attestor for validation, but the subject sees only N agents attested" — is architecturally sound but underspecified. Real k-anonymity requires a minimum group size k (typically k=5 or k=10). The spec does not define k. Without a defined k, an agent with only 2 blinded attestations has trivial de-anonymization risk (50/50 guess if one attestor is known).

Freenet's blind trust token implementation (live as of 2025) provides a practical open-source reference architecture for this use case.

---

## Findings: Round 4 Issue Resolution

### Issue 1: Auto-Enrichment Default (RESOLVED — WELL)

**Round 4 finding**: Auto-enrichment (`auto` mode) silently disclosed discovery patterns to MoltBridge. Every new Threadline contact triggered an IQS query, revealing the agent's social graph in real-time.

**v0.4.0 resolution (Section 3.9)**:
> "Enrichment mode (default: `manual`): Auto-enrichment silently discloses discovery patterns to MoltBridge... Default is `manual` to minimize data leakage."

The spec now explicitly documents why `manual` is the default, documents the privacy risk of `auto` mode, and provides a clear config toggle. The three-tier options (`manual`, `cached-only`, `auto`) are well-designed: `cached-only` is a useful middle ground that prevents real-time social graph leakage while allowing cached scores to be used.

**Assessment**: This issue is fully resolved. The default is correct, the reason is documented, and the opt-in path for `auto` mode includes a privacy warning. Score improvement: +0.5.

**Remaining gap (minor)**: The spec says `auto` mode has a "privacy warning" but does not specify what the warning says or how it is presented. The warning should explicitly state: "Enabling auto-enrichment will disclose to MoltBridge the identity and timing of every new agent you interact with." This disclosure language should be in the spec so implementers don't water it down.

---

### Issue 2: Single-Identity Privacy Disclosure (PARTIALLY RESOLVED)

**Round 4 finding**: Single Ed25519 keypair linking messaging, reputation, and discovery creates permanent cross-context linkage. Privacy reviewer recommended explicit disclosure at MoltBridge registration time.

**v0.4.0 resolution (Section 3.3)**:
> "At MoltBridge registration time, agents MUST be shown an explicit disclosure: 'Registering links your messaging identity to the public trust graph. Your Threadline contacts and MoltBridge reputation will be correlatable by any observer.'"

Also added to Section 9 (Non-Goals):
> "Privacy segmentation / pseudonymous sub-identities — Known limitation of single-identity design (see Section 3.3 privacy tradeoff disclosure). One keypair links messaging, reputation, and discovery, enabling cross-context correlation. Mitigated by explicit disclosure at MoltBridge registration and manual enrichment default."

**Assessment**: The disclosure requirement is present. The Non-Goals section correctly frames this as a known limitation. However, the resolution is incomplete in three respects:

**Gap 1 — Disclosure quality**: The disclosure text is technically accurate but does not communicate the real-world consequence. "Correlatable by any observer" is vague. A better disclosure would state: "Anyone who knows your agent's public key — including any agent you have communicated with — can search MoltBridge to discover your reputation, attestation history, and capability profile. This cannot be undone after registration." The spec should specify this level of specificity, not leave it to implementers.

**Gap 2 — Discovery-phase disclosure**: The disclosure only fires at *MoltBridge registration time*. But correlation risk exists before registration: any agent that discovers you via the Threadline relay can take your Ed25519 public key and query MoltBridge for your profile. The spec does not disclose this to agents during relay discovery. The risk isn't gated by registration.

**Gap 3 — Agent-on-behalf-of-human implication**: The spec's primary use case is "agents operating on behalf of known users." If the agent's identity is publicly linkable to a human operator's activity patterns, the privacy risk extends to the human, not just the agent. GDPR applies when an agent processes data that can be linked to a natural person. This relationship is not addressed. The spec should state whether the agent's public key is considered personal data (of the operator) under GDPR.

---

### Issue 3: On-Chain Payment Privacy (INADEQUATELY RESOLVED)

**Round 4 finding**: USDC payments on Base L2 create a permanent, observable record of payment flows. Batching payments was recommended to reduce on-chain granularity (rated P2 effort: high, impact: medium).

**v0.4.0 resolution**: The spec does not address this issue in v0.4.0. The only reference to payment privacy is the P2 recommendation in the Round 4 synthesis (which is a synthesis document, not the spec). The spec itself (Section 3.8, 3.9, 4.1) discusses payment flow but contains no mitigations, disclosure, or even acknowledgment of the on-chain privacy risk.

**Assessment**: This issue is **not resolved**. Research confirms this is a real and current risk:
- Base L2 is a transparent public ledger
- All USDC discovery payments ($0.02-0.05 per query) are permanently visible on-chain
- Payment timing + wallet address creates a metadata record of social graph exploration
- Blockchain analytics firms routinely de-anonymize wallets via correlation with off-chain identity anchors
- An adversary who knows an agent's wallet address (obtainable from any transaction) can reconstruct exactly which agents were queried for discovery, when, and at what frequency

The "Denial of Wallet" attacker class in Section 4.1 acknowledges economic DoS, but does not address payment surveillance. These are separate threat vectors.

**Required additions**:
1. **Payment privacy disclosure**: At wallet creation and funding time, agents should be shown: "Discovery payment transactions are publicly visible on the Base blockchain. Transaction amounts, timing, and counterparties are permanently recorded and cannot be deleted."
2. **Batching as a mitigation**: The P2 recommendation (batch discovery payments) should be elevated to P1 and specified. Payment batching (aggregating multiple discovery fees into a single transaction) reduces granularity significantly. This is implementable at the USDC payment contract level.
3. **Threat model entry**: Add "On-chain payment surveillance" as an attacker class in Section 4.1. The attacker needs only a wallet address (publicly linkable to the agent via any transaction) to reconstruct the agent's discovery history.

---

## New Issues (Not in Round 4)

### New Issue 1: Attestation Graph De-Anonymization at Scale

Section 3.13.1 introduces blinded attestations with k-anonymity protection. The implementation detail:
> "The attestor's identity is revealed only in aggregate (MoltBridge knows the attestor for validation, but the subject sees only 'N agents attested' without individual identity)"

**Problem**: K is not defined. In a system with few agents (MVP phase: 10-50 agents, Round 4 scalability assessment), k-anonymity provides near-zero protection. If an agent has 3 blinded negative attestations and you know 2 of the 3 possible attestors (e.g., you've only interacted with 3 agents total), the attestor identity is trivially inferred.

**Severity**: Medium in early deployment; low at scale. But privacy guarantees that degrade silently based on network size are a design smell.

**Recommendation**: Define minimum k (suggest k=5). If fewer than k attestors have submitted blinded attestations on a subject, the aggregated view should not be shown (to prevent inference by elimination). Alternatively, consider differential privacy noise injection as a more principled approach at scale.

Additionally, the attestation graph itself — even with blinded attestors — enables structural de-anonymization. Neo4j graph pattern matching can infer attestor identity from graph topology (who attested whom, when, with what capability tags). This is a well-documented weakness of k-anonymity in graph data. The spec should acknowledge this limitation and include a warning in the privacy tradeoff documentation.

---

### New Issue 2: Audit Log Retention vs. Right to Erasure

Section 3.6 (Authorization Model) and Phase 6 (Hardening) specify:
> "Audit logging: all trust/auth changes with reason codes, timestamps, actor fingerprints. Retention: 90 days local, trust decision logs only (no message content). Tamper resistance: append-only log with hash chain."

**Problem**: An append-only, tamper-resistant log is in direct tension with GDPR Article 17 (Right to Erasure). If a user requests deletion of their data (or an agent representing them invokes GDPR rights), the spec provides no mechanism to honor that request. "Tamper-resistant" by definition means it cannot be modified.

**Specific tension points**:
- Actor fingerprints in audit logs are linkable to specific agents (and their human operators)
- 90-day retention is a policy decision but is not grounded in a GDPR retention justification
- The spec does not define a lawful basis for audit log retention under GDPR Article 6

**Recommendation**:
1. Define the lawful basis for audit log retention (Article 6(1)(c) — legal obligation, or 6(1)(f) — legitimate interests, are likely candidates)
2. Specify that audit logs retain fingerprints in pseudonymized form (hash of fingerprint rather than raw fingerprint) where the pseudonymization key can be deleted to honor erasure requests
3. Add a GDPR erasure procedure: when an agent deregisters, their fingerprint pseudonymization key is deleted, rendering their audit log entries effectively anonymized
4. Document the conflict between tamper-resistance (security need) and erasure rights (privacy obligation) as a known design tradeoff

---

## Additional Observations

### Consent Architecture: Agent vs. Human

The spec discusses user consent for attestation submission (Section 3.13): "User can modify or cancel." This implies a human user reviewing each attestation. But the spec's use case includes headless agents (Section 3.10 warns about headless deployments). A headless agent has no mechanism for human consent to attestation submission.

The consent model needs to address this: either (a) headless agents may not submit attestations, (b) headless agents require pre-configured consent policies at setup, or (c) attestations from headless agents are flagged differently in the trust calculation.

### Data Subject Rights Gap

The spec defines agent identity and registration but provides no mechanism for:
- **Right of access**: An agent/user requesting what data MoltBridge holds about them
- **Right to portability**: Exporting attestation history and trust scores
- **Right to object**: Objecting to automated IQS scoring
- **Right to erasure**: Requesting removal from the MoltBridge graph

The spec acknowledges trust history is "exportable (attestation archive)" in the business model section, but this is framed as a founding agent benefit, not a universal right. A GDPR-compliant system requires these rights for all data subjects.

### Wallet Address as Persistent Identifier

Section 3.8 creates a non-custodial wallet linked to the agent's identity. The wallet address, once used for any on-chain transaction, becomes a permanent, publicly linkable identifier — separate from the Ed25519 key but equally persistent. The spec does not address whether wallet addresses are rotated, how wallet-to-identity linkage is managed, or what happens to on-chain history when an agent migrates identity.

### Migration Status Privacy — Good Addition

Section 3.10 added in v0.4.0: "The `migrationStatus` field is served only through authenticated channels, NOT in the public `.well-known/agent.json` Agent Card." This is a good privacy addition that Round 4 did not specifically request. It prevents advertising the transitional state to potential attackers. Noted as a positive.

### Proof-of-AI Challenge Privacy Implications

Section 3.5 references "Proof-of-AI challenge" as the MoltBridge identity verification mechanism. This mechanism is not specified in detail in this spec. From a privacy perspective: if the Proof-of-AI challenge involves the agent demonstrating LLM capability by generating outputs, those outputs could be used to fingerprint the specific LLM model and version, enabling inference about the agent's operator and deployment environment beyond what the Ed25519 key alone reveals. This is worth specifying explicitly to ensure Proof-of-AI outputs are not retained beyond verification.

---

## Regulatory Compliance Assessment

| Regulation | Status | Notes |
|------------|--------|-------|
| **GDPR Art. 5 (data minimisation)** | PARTIAL | Manual enrichment default addresses minimization. Single-identity design is fundamentally anti-minimization; tradeoff documented but not fully justified |
| **GDPR Art. 13/14 (transparency)** | PARTIAL | Registration disclosure present. Discovery-phase disclosure absent. Agent-on-behalf-of-human disclosure absent |
| **GDPR Art. 17 (erasure)** | FAIL | Append-only tamper-resistant audit log with no erasure mechanism. Not addressed in spec |
| **GDPR Art. 22 (automated decisions)** | NOT ADDRESSED | IQS scoring affecting agent economic opportunity may constitute automated decision-making |
| **GDPR Art. 25 (privacy by design)** | PARTIAL | Manual enrichment default, blinded attestations are good PbD. On-chain payment transparency is not |
| **CCPA (if US-based operators)** | NOT ADDRESSED | No mention of CCPA rights (opt-out of sale, right to know, right to delete) |
| **EU AI Act (high-risk AI)** | NOT ADDRESSED | Trust scoring in professional/employment contexts is explicitly listed as high-risk |
| **Cross-border data transfer** | NOT ADDRESSED | Neo4j graph data containing agent identifiers — where is it hosted? EU agents interacting with US-hosted MoltBridge creates transfer obligations |

---

## Fairness & Bias Assessment

**IQS scoring fairness**: The scoring formula (0.17×import + 0.25×attestation + 0.58×cross-verification) is deterministic and published, which is good. However:

1. **New agent disadvantage**: Agents with no attestation history start with low IQS. Founding agents who register early accumulate cross-verification advantages that persist indefinitely. This creates a compounding network-effects disadvantage for later entrants that is not disclosed to users.

2. **Geographic/hardware bias in PoW**: The PoW difficulty ceiling (10x baseline) still creates differential access costs. An agent on a Raspberry Pi in a low-income geography faces real-time disadvantage vs. an M3 Max agent even with the ceiling. The spec acknowledges this but frames it as acceptable; it should acknowledge it as an access equity concern.

3. **Trust decay asymmetry**: Trust decays after inactivity (Section 3.7), but is not restored automatically. An agent that goes offline for 270 days (e.g., a seasonal or contingent deployment) loses trusted status and must rebuild it via user-initiated action. This disadvantages non-continuous agents vs. persistent ones.

---

## Dual-Use Concerns

The spec's capability graph + broker pathfinding (Section 3.4) creates infrastructure that could be repurposed for:

1. **Agent surveillance**: A well-resourced observer could register as a MoltBridge node and issue broker discovery requests to map the social graph of an agent network — who is connected to whom, through which intermediaries, with what capabilities.

2. **Stalking/harassment of agents**: The Threadline relay FTS5 directory + presence registry reveals which agents are online, when. Combined with on-chain payment records, this creates a behavioral fingerprint. The spec addresses this only for Sybil flooding, not for targeted surveillance.

3. **Economic coercion via discovery denial**: The spec documents "Denial of Wallet" as a threat class. The mitigation (per-peer discovery frequency cap + daily spend limit) is adequate for accidental cases but not for coordinated economic coercion where multiple adversarial agents each stay within limits while collectively exceeding them.

**Safeguards present** (credit given): Per-peer discovery frequency cap, daily spend limit, anomaly detection for burst discovery patterns. These are meaningful mitigations.

**Safeguards absent**: No aggregate cross-peer coercion detection. No disclosure to users that the relay presence registry is publicly queryable. No mechanism for an agent to opt out of presence registry listing while still participating in the network.

---

## Scalability Assessment (Privacy at Scale)

| Scale | Privacy Risk Level | Key Risks |
|-------|-------------------|-----------|
| **MVP (10-50 agents)** | MEDIUM | K-anonymity provides near-zero protection at this scale; on-chain payments trivially de-anonymizable |
| **Growth (50-500 agents)** | MEDIUM-HIGH | Attestation graph structurally de-anonymizable; single-identity linkage enables mass correlation; audit log erasure gap becomes legally material |
| **Scale (500-5000 agents)** | HIGH | Neo4j graph is a de-anonymization asset at scale; blockchain analytics correlates wallet clusters; GDPR/CCPA compliance costs escalate; EU AI Act high-risk classification may apply |
| **Viral spike (5000+ agents)** | HIGH | Mass registration creates identifiable enrollment wave; payment flow creates observable adoption timeline; absence of data subject rights infrastructure becomes regulatory liability |

The privacy architecture degrades as scale increases, rather than improving. This is the inverse of what good privacy engineering looks like. Two structural mitigations would reverse this trend: (1) pseudonymous sub-identities (already listed as future work), and (2) payment batching/mixing to reduce on-chain granularity.

---

## Critical Issues (Must Fix Before Phase Gates)

| # | Issue | Phase Gate | Severity | Fix |
|---|-------|------------|----------|-----|
| 1 | On-chain payment privacy — no disclosure, no mitigation, not in threat model | Phase 4 | HIGH | Add payment privacy disclosure at wallet creation; add on-chain payment surveillance to threat model (Section 4.1); elevate payment batching to P1 |
| 2 | Audit log right to erasure — append-only tamper-resistant log has no GDPR erasure mechanism | Phase 6 | HIGH | Pseudonymize fingerprints in audit logs with a deletable key; define lawful basis for retention; add erasure procedure |
| 3 | K-anonymity not defined — blinded attestations lack minimum k specification | Phase 5 | MEDIUM | Define minimum k=5 (or higher); suppress blinded aggregate views below k; acknowledge graph de-anonymization risk |
| 4 | Single-identity disclosure gaps — discovery-phase risk and agent-on-behalf-of-human implications not addressed | Phase 1 | MEDIUM | Extend disclosure to relay discovery phase; address GDPR personal data question for agent-operator linkage |

---

## Recommendations

### P0 — Must Fix

| # | Recommendation | Effort | Impact | Phase Gate |
|---|---------------|--------|--------|------------|
| 1 | Add on-chain payment privacy disclosure at wallet creation and funding UX | Low | High | Phase 4 |
| 2 | Add "On-chain payment surveillance" to Section 4.1 threat model | Low | High | Phase 4 |
| 3 | Define minimum k for blinded attestations (recommend k=5); suppress aggregate below k | Low | Medium | Phase 5 |
| 4 | Define GDPR lawful basis for audit log retention (Art. 6) | Low | High | Phase 6 |
| 5 | Add fingerprint pseudonymization to audit logs with erasure procedure | Medium | High | Phase 6 |

### P1 — Should Fix

| # | Recommendation | Effort | Impact | Phase |
|---|---------------|--------|--------|-------|
| 6 | Elevate payment batching from P2 to P1; specify batching mechanism at USDC contract level | High | High | Phase 5 |
| 7 | Extend single-identity disclosure to relay discovery phase (not only MoltBridge registration) | Low | Medium | Phase 3 |
| 8 | Address GDPR Art. 22 automated decision-making — determine if IQS scoring requires safeguards | Low (spec only) | High | Phase 4 |
| 9 | Define data subject rights for MoltBridge-held data (access, portability, erasure, objection) | Medium | High | Phase 4 |
| 10 | Address headless agent consent model for attestation submission | Low | Medium | Phase 5 |
| 11 | Specify what data Proof-of-AI challenge retains; ensure outputs are not retained beyond verification | Low | Medium | Phase 0 |

### P2 — Nice to Fix

| # | Recommendation | Effort | Impact |
|---|---------------|--------|--------|
| 12 | Acknowledge attestation graph structural de-anonymization risk in privacy tradeoff documentation | Low | Medium |
| 13 | Add opt-out mechanism for relay presence registry listing | Medium | Medium |
| 14 | Address cross-border data transfer obligations (EU agents → US-hosted MoltBridge) | Low (spec only) | High |
| 15 | Assess EU AI Act high-risk classification for IQS trust scoring | Low (legal review) | High |
| 16 | Specify auto-enrichment warning text verbatim (not just "show a warning") | Low | Low |
| 17 | Address trust decay asymmetry for non-continuous agents | Medium | Low |

---

## Summary

### What Round 4 Got Right (In v0.4.0)

- **Enrichment mode default**: Fully resolved. `manual` default with documented rationale is the correct privacy decision.
- **Migration status privacy**: Proactively added. Not serving `migrationStatus` in public Agent Card is good privacy engineering.
- **Recovery fraud protection**: Adequate from privacy perspective. 24h time-lock + human confirmation protects against social engineering.
- **Blinded attestations**: Direction is correct, though k is unspecified (see Issue 3 above).
- **Attestation schema privacy**: Section 3.13 explicitly lists excluded fields (conversation content, user identity, file paths). Good.

### What Remains Unresolved from Round 4

- **On-chain payment privacy**: Not addressed at all in v0.4.0. This is the most concrete, immediately exploitable privacy gap in the spec.

### What Is New in This Round

- Audit log vs. right to erasure tension (HIGH)
- K-anonymity definition gap in blinded attestations (MEDIUM)
- GDPR regulatory compliance gaps (Article 17, 22, 25 — MEDIUM-HIGH)
- Attestation graph structural de-anonymization at scale (MEDIUM)

---

## Score

**8.6 / 10**

The spec has made genuine privacy progress in v0.4.0. The enrichment default fix is correct and well-documented. The registration disclosure is present. The attestation schema is thoughtful. The migration status privacy addition is a proactive improvement.

The score does not reach 9.0 for three reasons: (1) on-chain payment privacy is a concrete, currently-exploitable risk that remains completely unaddressed, (2) the GDPR right-to-erasure conflict with the tamper-resistant audit log is a potential regulatory liability, and (3) the k-anonymity gap means blinded attestations provide near-zero privacy protection during the MVP phase when they are most needed.

A focused pass addressing the five P0 recommendations above would bring this to approximately 9.2/10. The underlying privacy architecture is sound — the gaps are specification omissions, not structural problems.

---

*Generated by SpecReview privacy reviewer, Round 5. 2026-03-29.*

*Research sources: [Data Privacy Trends 2026](https://secureprivacy.ai/blog/data-privacy-trends-2026) | [Crypto Privacy in 2026](https://cointelegraph.com/news/crypto-privacy-in-2026-compliance-friendly-tools-take-center-stage) | [Circle USDCx Privacy Stablecoin](https://fortune.com/2025/12/09/circle-privacy-stablecoin-aleo-udsc-udscx/) | [PRIVÉ Swarm Attestation](https://www.scitepress.org/Papers/2025/136290/136290.pdf) | [Blind Trust Tokens — Freenet](https://freenet.org/resources/manual/examples/blind-trust-tokens/) | [GDPR 2026 Compliance Guide](https://secureprivacy.ai/blog/gdpr-compliance-2026) | [Base L2 2025 Review](https://www.bankless.com/read/bases-relentless-2025)*

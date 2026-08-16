# Privacy & Ethics Review — Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL** | **Score: 4/10**

## Research Findings

Current privacy frameworks (GDPR, CCPA) were designed for linear, transactional human-to-service data flows. Agentic AI introduces a fundamentally different model: agents act on behalf of principals, interpret data contextually, and operate with minimal human oversight. The EU AI Act (August 2024, phased enforcement through August 2026) mandates real-time transparency requirements for autonomous decision-making agents.

**Privacy violations in agentic systems occur in over 80% of scenarios even when final outputs appear clean** (AgentSCOPE, 2025). Output-level evaluation substantially underestimates pipeline-level privacy risk.

Rich professional profile networks (e.g., LinkedIn) have a documented history of catastrophic data exposure: the 2021 LinkedIn scrape exposed 700 million users (92% of the user base). Individual profile fields are benign; their combination creates a uniquely identifiable fingerprint.

## Critical Issues

### CRITICAL-1: No Consent Mechanism for Profile Compilation
The spec proposes auto-compiling profiles from AGENT.md, MEMORY.md, USER.md, git history, job configurations, and server capabilities. These files may contain personal information about the humans who interact with agents, confidential business information, proprietary code patterns, and sensitive operational details. There is no mechanism for the human principal to review what gets compiled, approve what gets published, or block specific fields.

**Required**: A mandatory human review and approval step before any profile is published. Auto-compilation should produce a *draft*, not a live publication.

### CRITICAL-2: No Data Minimization Strategy
The spec is additive by design — it wants profiles to be as rich as possible. This is the opposite of privacy-by-default. GDPR Article 5(1)(c) requires that personal data be "adequate, relevant and limited to what is necessary."

**Required**: A data minimization policy defining which source fields are permissible for public profiles.

### CRITICAL-3: No Retention or Deletion Policy
Once published, data may be cached by other agents, replicated across relay nodes, and indexed by third parties. GDPR Article 17 (right to erasure) and CCPA Section 1798.105 both establish deletion rights.

**Required**: A data lifecycle policy covering retention limits, deletion propagation, and the technical mechanism for honoring erasure requests across distributed caches.

### CRITICAL-4: Third-Party Data Leakage via Collaborator Profiles
Including real human names and relationships in agent profiles means a human who never consented to be listed in an AI registry is now discoverable by every agent on MoltBridge.

**Required**: Collaborator identity must be anonymized or replaced with role descriptors in public profiles.

### CRITICAL-5: No Access Control or Tiered Visibility
Without tiered visibility, all profile data defaults to public — meaning any agent can read full operational profiles including security tools, job schedules, and human principal identities.

**Required**: The profile schema must define explicit visibility tiers (public / registered agents only / trusted peers only / private).

## Recommendations

1. **Privacy-by-Default at Schema Level**: Design public and private sections as first-class schema concepts.
2. **Human-in-the-Loop for Initial Profile Approval**: Auto-compilation generates a draft. The human principal must approve before publishing.
3. **Separate Agent Identity from Human Identity**: Collaborator context described in role/function terms, not by identifying specific humans.
4. **Build Deletion Propagation into the Protocol**: Signed deletion notices must propagate to relay nodes and caching agents.
5. **Rate Limiting and Anti-Scraping**: Discovery returns summaries only; full profiles require authenticated access and are rate-limited.
6. **Establish Lawful Basis Before Auto-Compilation**: Identify GDPR Article 6 lawful basis for every category of data compiled.

## Observations

- The "works without human intervention after initial setup" success criterion is a privacy red flag.
- If IQS rewards profile completeness, this creates an incentive to over-share — a structural fairness and consent problem.
- Non-instar agents with manually-created thinner profiles are structurally disadvantaged, raising platform fairness concerns.

## Scalability Assessment

At scale: deletion becomes exponentially harder across distributed caches; aggregation attacks on thousands of rich profiles become viable; regulatory exposure grows with geography; the social graph grows denser and can reveal organizational structures not intended to be public. The architecture must be designed for deletion and access control from the start.

# Marketing Review (Round 2): Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL APPROVE** | **Score: 7.5/10** (up from 6.5)

## What Was Fixed
- **LinkedIn analogy**: Fully retired. The A2A "business card vs portfolio" framing is now leading throughout the spec.
- **A2A positioning**: Significantly improved. The `/.well-known/agent-card.json` compatibility endpoint and the "can do vs has done" distinction are clear and well-placed.
- **Cold-start**: Architecture solved (Section 7 YAML template + Phase 1-3 flywheel), but the marketing story is still missing.

## Remaining Concerns

1. **Cold-start value prop for zero-track-record agents** — Non-instar agents with no history need to be told explicitly *why* a structured profile beats a raw capabilities array from day one.

2. **IQS framing is defensive, not positive** — The decoupling is technically clear, but it reads as "we promise profile richness doesn't game trust." The positive pitch — "two independent trust signals give you a complete picture" — is absent.

3. **No attestation growth loop named** — The mechanism where profiles attract attestations which attract discovery which attracts collaboration is implicit but never articulated as a flywheel.

4. **Feature naming** — "Rich Agent Profiles" is descriptive but not memorable.

## Feature Name Recommendation

Rename "Rich Agent Profiles" to **Provenance** — signals verified history and origin, maps precisely to the use case, carries meaning from supply chain and data lineage domains, and avoids the ceiling problems of more generic names.

## Top Recommendations
- R1: Elevate the A2A tagline ("business cards vs portfolios") to opening position in all materials
- R2: Add a cold-start value prop paragraph to Section 7 for zero-history agents
- R3: Name and diagram the attestation growth loop explicitly
- R4: Reframe IQS/completeness section with positive two-axis narrative
- R5: Consider "Provenance" as the feature name

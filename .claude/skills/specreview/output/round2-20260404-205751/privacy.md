# Privacy & Ethics Review (Round 2): Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL APPROVAL** | **Score: 8/10** (up from 4/10)

## Round 1 Blockers — All Resolved

All 5 Round 1 privacy blockers are resolved in v2:
- **Consent gate**: Full 5-layer consent model added (Section 5.3)
- **Source allowlist**: USER.md banned, MEMORY.md tag-gated to `#profile-safe` only (Section 3.1)
- **Deletion path**: DELETE endpoint + GDPR 30-day erasure with cache propagation (Section 5.4)
- **Human collaborator PII**: Names replaced with role descriptors; redact endpoint added (Section 5.2)
- **IQS decoupling**: Completely separated; separate `profile_completeness_score` (Section 8)

## Residual Concerns (Non-Blocking)

1. **Auto-publish 20% threshold is character-based, not semantic** — a targeted narrative change ("works on internal tooling" → "leads cryptographic infrastructure for 500 agents") could slip through under the threshold
2. **GDPR attestation anonymization is underspecified** — what does "anonymized" mean for orphaned attestations in a graph database where timing correlation could re-identify deleted agents?
3. **Trust score exposed as raw float in Discovery Cards** creates a de-anonymization surface at scale — banding (low/medium/high) is preferable
4. **ProfileVersion[] has no retention policy** — old versions could retain fields that were later set to private
5. **Principal transfer event not covered** in data lifecycle
6. **EU AI Act compliance still unassessed** (flagged in Round 1 synthesis, still a gap)

## Recommendations
- R1: Add semantic significance check to auto-publish gate (new capability claims always require review — already specified, but narrative claim escalation is missing)
- R2: Define attestation anonymization concretely (replace agent_id with random UUID, strip timing to month-level granularity)
- R3: Band trust scores in Discovery Cards (low/medium/high) instead of raw floats
- R4: Add version retention policy (purge versions older than 90 days, or redact private-marked fields from old versions)

# DX / API Design Review (Round 2): Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL APPROVE** | **Score: 8.2/10** (up from 6.5)

## What Was Addressed

| Round 1 Finding | Status in v2 |
|----------------|-------------|
| No profile schema | RESOLVED — Full TypeScript interface (§2.3) |
| Non-instar onboarding wall | RESOLVED — YAML template §7.2, registration path §7.1 |
| Freshness triggers undefined | RESOLVED — Content-hash + 24hr debounce + jitter §3.4 |
| No progressive disclosure | RESOLVED — Three-tier architecture §6.1 |
| No deletion endpoint | RESOLVED — DELETE /agent/profile with tombstone §5.4 |
| No consent mechanism | RESOLVED — Human review gate §3.2, auto-publish opt-in |
| IQS decoupling | RESOLVED — Separate profile_completeness_score §8 |
| A2A compatibility | RESOLVED — /.well-known/agent-card.json §2.5 |

## Critical Issues

**CRIT-DX-1: Canonical Serialization Fragile**
JSON.stringify sort is shallow; ISO8601 format ambiguous; Unicode normalization unspecified. Fix: RFC 8785 (JCS), exact timestamp format, NFC normalization.

**CRIT-DX-2: PUT /agent/profile Has No Partial Update**
Full replacement means re-signing entire 50KB for one track record entry. Add PATCH or document why atomic replacement is intentional.

## Key Recommendations
- R1: profile_completeness_score must be server-computed, not agent-submitted
- R2: Non-instar first publication needs equivalent gate (24hr pending state)
- R3: /verify response needs version, pubkey_matches_registered, current_version
- R4: SDK method signatures for profile CRUD
- R5: field_visibility should use union type not Record<string, visibility>
- R6: Error contract for all 8 endpoints (especially version conflicts and timestamp rejections)
- R7: Define #profile-safe tag syntax with positive/negative examples

## Score Breakdown

| Dimension | Round 1 | Round 2 |
|-----------|---------|---------|
| Schema completeness | 2/10 | 9/10 |
| Non-instar onboarding | 3/10 | 7/10 |
| Progressive disclosure | 5/10 | 9/10 |
| API consistency | 7/10 | 7.5/10 |
| Security ergonomics | 4/10 | 7/10 |
| Error handling | 2/10 | 2/10 |
| SDK/client design | 2/10 | 3/10 |
| Documentation quality | 6/10 | 8.5/10 |

**Status: CONDITIONAL APPROVE — resolve canonicalization before cutting moltbridge@0.2.0**

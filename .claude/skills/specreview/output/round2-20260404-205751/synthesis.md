# SpecReview Synthesis: Rich Agent Profiles for MoltBridge (Round 2)

**Review ID**: round2-20260404-205751
**Date**: 2026-04-05
**Round**: 2
**Reviewers**: All 8
**Spec Version**: v2

---

## Overall Assessment

**Status**: CONVERGING → CONDITIONAL APPROVE
**Average Score**: 7.5 / 10 (up from 4.8 in Round 1)
**Score Range**: 6.5 - 8.2
**Blockers**: 0 (down from 2)

| Reviewer | R1 Score | R2 Score | R2 Status | Key Finding |
|----------|----------|----------|-----------|-------------|
| Security | 3 | 7.5 | CONDITIONAL | Canonical serialization (RFC 8785) needed; replay nonce gap |
| Scalability | 4 | 7 | CONDITIONAL | Cost model needs active/dormant segmentation; MVP greenlit |
| Business | 6.5 | 7.5 | CONDITIONAL | Revenue model absent; demand-side pull mechanism needed |
| Architecture | 6.5 | 8 | CONDITIONAL | All R1 blockers resolved; canonicalization before signing code |
| Privacy | 4 | 8 | CONDITIONAL | All 5 R1 blockers resolved; residual items non-blocking |
| Adversarial | 3 | 6.5 | CONDITIONAL | Phases 1-3 safe; Phase 4 needs temporal ring detection |
| DX / API | 6.5 | 8.2 | CONDITIONAL | Schema exists; needs PATCH endpoint and error contracts |
| Marketing | 6.5 | 7.5 | CONDITIONAL | A2A positioning strong; consider "Provenance" as feature name |

---

## Round 2 Consensus (New Issues)

### 1. RFC 8785 Canonical Serialization (4/8 reviewers)
Flagged by: Security, Architecture, DX, Adversarial
The JSON.stringify approach is insufficient. Must adopt RFC 8785 (JCS) with NFC Unicode normalization.
**Status**: ADDRESSED in spec v2.1

### 2. Auto-Publish Incremental Poisoning (3/8 reviewers)
Flagged by: Security, Adversarial, Privacy
20% character threshold allows gradual profile replacement. Need max consecutive auto-publishes + field-level diff.
**Status**: ADDRESSED in spec v2.1

### 3. Server-Computed Completeness Score (3/8 reviewers)
Flagged by: DX, Security, Adversarial
profile_completeness_score must be computed server-side, not agent-submitted. Attested component should be weighted by attestor IQS.
**Status**: ADDRESSED in spec v2.1

---

## Convergence Status

| Metric | Round 1 | Round 2 |
|--------|---------|---------|
| Approvals | 0/8 | 0/8 |
| Conditional | 6/8 | 8/8 |
| Blockers | 2/8 | 0/8 |
| Average Score | 4.8 | 7.5 |
| Open Conflicts | 2 | 0 |

**Convergence**: CONVERGING — All reviewers conditional approve. No blockers. Three Round 2 consensus items addressed in v2.1. Remaining items are implementation-phase refinements, not spec-blocking.

---

## Remaining Items (Implementation Phase, Not Spec-Blocking)

1. Revenue model hypothesis (Business)
2. Error contract for API endpoints (DX)
3. PATCH endpoint for partial updates (DX)
4. Temporal ring detection for Phase 4 (Adversarial)
5. Consumer auth protocol for non-instar agents (Architecture)
6. Compilation queue architecture for Growth phase (Scalability)
7. EU AI Act compliance assessment (Privacy)
8. #profile-safe tag syntax definition with examples (DX/Security)

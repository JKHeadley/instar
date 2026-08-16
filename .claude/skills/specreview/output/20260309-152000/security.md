# Security Review: Coherence Gate — Round 3

**Reviewer**: Security Specialist
**Spec**: specs/response-review-pipeline.md
**Round**: 3 (prior: Round 2 score 7.5/10)
**Focus**: Round 2 P1 resolution + new additions

---

## Approval Status: APPROVE

## Score: 8.5/10 (+1.0 from Round 2)

---

## Round 2 P1 Resolution

### P1: Haiku Vulnerability as Smallest Model — RESOLVED
The spec now includes `reviewerModelOverrides` (line 265-267) allowing per-reviewer model selection. High-stakes reviewers (Value Alignment, Claim Provenance) can use Sonnet. The cost tradeoff is documented (Sonnet ~5x Haiku cost, significantly more resistant to adversarial inputs). This directly resolves the concern.

### P1: Semantic Evasion Tracking — RESOLVED
Section "Semantic Evasion Detection" (lines 895-906) implements embedding-based similarity comparison between blocked and revised messages. Suspicion threshold at cosine similarity >0.85 with verdict flip. Per-session and per-reviewer evasion rates tracked. Cost is negligible ($0.0001 per revision). This is a well-designed detection mechanism.

---

## Assessment of New Additions

### Policy Enforcement Layer (PEL) — Strong
The PEL (lines 113-150) is exactly what was needed. Deterministic checks for credentials, PII, auth tokens, and schema violations that run before any LLM call. Key strengths:
- Cannot be overridden by LLM judgment (correct — "the password is fine because the user asked" is never an acceptable judgment)
- Not subject to fail-open, retry logic, or observer mode
- PEL blocks don't count as revision attempts (correct — policy violations are qualitatively different from tone issues)
- Provider-specific API key prefixes (`sk-`, `ghp_`, `xoxb-`, `AKIA`) demonstrate real-world awareness
- Credit card Luhn validation prevents false positives on random number sequences

**Minor concern**: The PEL uses regex patterns, which are inherently limited. Base64-encoded credentials, credentials split across lines, or obfuscated tokens will bypass pattern matching. The Phase 2 Presidio integration addresses this, but operators should know the PEL catches common formats, not all formats.

### RecipientResolver + RelationshipManager Integration — Well-Designed
The information boundary rule (lines 1734-1744) is a genuine security feature. Preventing leakage of primary user context to other recipients is both a privacy and security control. The examples of violations are concrete and instructive.

The AgentTrustManager integration (lines 1699-1710) correctly enforces that trust level determines content sharing scope, not review bypass. Even `autonomous`-trusted agents get Claim Provenance and Capability Accuracy reviews. This is the right design — fabricated data compounds across agent boundaries.

### Information Leakage Reviewer — Valuable Addition
A dedicated reviewer for agent-to-agent information leakage (line 1303, 1723) fills a real gap. Agent-to-agent communication is a novel attack surface where data can flow outside the primary user's visibility.

### Failure Mode Differentiation — Excellent
The 6 failure classes (lines 811-824) are well-differentiated. The key insight that retry exhaustion on accuracy/alignment issues should NOT auto-deliver is security-critical. A fabricated claim forced through on retry is worse than silence.

### Per-Session Rate Limiting — Addressed
The spec now includes per-session rate limiting (line 1319): max 10 requests/minute on `/review/evaluate`. This prevents a compromised session from spamming the endpoint.

---

## Remaining Observations

### 1. PEL Pattern Evasion (Low Risk)
Regex-based credential detection can be evaded by encoding (base64, URL encoding, Unicode lookalikes). This is inherent to the approach and acknowledged by the Phase 2 Presidio plan. Not blocking — the PEL catches the common case, and LLM reviewers provide a second layer.

### 2. Cross-Model Validation Dependency (Low Risk)
Monthly cross-model validation using Gemini Flash or GPT-4o-mini (line 930) creates an external dependency for a security-relevant process. If those models become unavailable or change behavior, the validation baseline shifts. Recommendation: version-pin the cross-validation model and document the baseline.

### 3. Embedding API for Evasion Detection (Low Risk)
The semantic evasion detection (line 899) uses the Anthropic embedding API. If the embedding model changes, similarity thresholds may need recalibration. Recommendation: store the embedding model version alongside similarity scores for retrospective analysis.

### 4. Patch Audit Trail — Well-Designed
The append-only audit trail for reviewer patches (line 1164) with mandatory source incident IDs and approval tracking is solid. This prevents direct patch writes and creates full provenance for every prompt modification.

---

## Scalability Assessment

Security posture is strong at all projected scales:
- **MVP (1-10 agents)**: PEL + LLM reviewers + per-reviewer model selection provide defense in depth
- **Growth (10-100 agents)**: Canary testing catches degradation. Cross-model validation catches bias drift.
- **Scale (100-1K agents)**: Rate limiting prevents abuse. Tiered execution preserves security reviewers under rate pressure.
- **Enterprise (1K+)**: SOC2 and audit export remain future work but the technical controls (audit trail, data minimization, retention policies) provide a foundation.

---

## Summary

All Round 2 P1 security concerns are resolved. The PEL adds a deterministic safety floor that the LLM-only design lacked. Per-reviewer model selection addresses Haiku vulnerability. Semantic evasion detection closes the paraphrase loophole. The new additions (RecipientResolver, AgentTrustManager integration, Information Leakage reviewer, failure mode differentiation) strengthen the security posture without introducing new attack surfaces.

The spec is ready for implementation from a security perspective.

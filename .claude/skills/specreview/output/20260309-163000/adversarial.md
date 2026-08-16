# Adversarial Review: Coherence Gate — Round 3.5 (Verification)

**Reviewer**: Adversarial
**Status**: APPROVE
**Round**: 3.5 (tightening pass)

---

## Verification Checklist

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Decision matrix | RESOLVED | The matrix is normative and first-match-wins. Critically, row 1 (PEL HARD_BLOCK) cannot be overridden by any combination of other inputs — this is correct and eliminates the most dangerous attack vector (gaming LLM reviewers to bypass hard policy). |
| 2 | Data flow contract | RESOLVED | The ordering (PEL sees raw text before scrubbing) is correct for security. An attacker cannot use scrubbing to hide credential patterns from PEL. |
| 3 | Trust boundary hardening | RESOLVED | Free-text exclusion is the right call. The field classification table is explicit. The attack I was most concerned about — adversarial text in `notes` field reaching reviewer prompts — is structurally prevented. The `tags` field validation (max 20 items, 30 chars, alphanumeric + hyphens) is also appropriately constrained. |
| 4 | Conversation advancement | RESOLVED | Stale revision abandonment closes the attack vector where an adversary could exploit timing to deliver a previously-blocked message after the conversation context changes. |
| 5 | V1 scope narrowing | RESOLVED | Semantic evasion as observability-only is the correct v1 decision — enforcing on insufficient calibration data would produce false positives and erode operator trust. Custom reviewer scripts deferred to v2 with explicit security requirements (sandboxing, signing) is correct. |
| 6 | Information Leakage reviewer | RESOLVED | The prompt is well-specified with trust-level-based disclosure scoping. The data minimization note (reviewer receives only message + recipientType + trustLevel, not tool output or value docs) prevents the reviewer itself from becoming a leakage vector. |
| 7 | Rate-limit backpressure | RESOLVED | The consolidated mode under pressure is acceptable. One concern: an attacker who can trigger rate limiting (by flooding the agent with messages) could force the pipeline into consolidated mode, which has lower detection granularity. However, this requires the attacker to already have message-sending capability, which is a high bar. |
| 8 | Test endpoint security | RESOLVED | Rate limiting (20/min) and the disable flag address the information leakage risk from the test endpoint. |
| 9 | Reviewer criticality | RESOLVED | High-criticality timeout = queue-and-hold prevents silent bypass of key reviewers via latency attacks. |

## Remaining Concerns

One minor residual: the rate-limit backpressure consolidated mode combines specialists into thematic groups. The specific groupings (Factual Coherence vs. Behavioral Coherence) are hardcoded in the spec. If an attacker knows these groupings, they could craft messages that exploit the boundaries between groups. This is low-priority — it requires both rate-limit pressure AND knowledge of groupings — but worth noting for v2 consideration.

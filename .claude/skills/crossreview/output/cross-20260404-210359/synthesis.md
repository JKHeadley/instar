# CrossReview Synthesis: Rich Agent Profiles for MoltBridge

**Review ID**: cross-20260404-210359
**Date**: 2026-04-05
**Models**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Spec Version**: v2.1

---

## Overall Verdict

**Status: CONDITIONAL APPROVE** | **Average: 8.5/10**

All three models approve with conditions. No blockers. The spec is implementation-ready for MVP with targeted fixes.

| Model | Score | Status |
|-------|-------|--------|
| GPT 5.4 | 8/10 | CONDITIONAL |
| Gemini 3.1 Pro | 8.5/10 | CONDITIONAL |
| Grok 4.1 Fast | 9/10 | CONDITIONAL |

---

## Consensus (All 3 Models Agree)

### 1. Discovery Card Signing Is Ambiguous
All three models flagged that the relationship between the Ed25519 signature and the Discovery Card fields is unclear. The signature covers the full profile, but Discovery Cards contain registry-computed fields (trust_score, completeness_score) that are NOT agent-signed.

**Resolution**: Split Discovery Cards into agent-signed fields + registry-computed metadata. Mark unsigned fields explicitly.

### 2. Key Rotation Has an Identity Contradiction
GPT and Grok directly flagged that agent_id = SHA-256(pubkey) means key rotation changes identity. Gemini flagged the centralized recovery as a bottleneck.

**Resolution**: Introduce stable logical identifier above the signing key, or define key-binding chain with signed rotation records.

### 3. Timestamp/Replay Needs Tightening
All three noted timestamp ambiguities — GPT on distributed clock skew, Grok on RFC 3339 format inconsistency, Gemini on thundering herd.

**Resolution**: Lock timestamp to exact format, define server as authoritative, specify skew tolerance.

---

## Unique Findings (Per Model)

### GPT 5.4 — Caught What Others Missed
- **Visibility model inconsistency**: Singular `visibility` on AgentProfile vs `field_visibility` on RichProfilePayload — a concrete schema bug
- **Three-state deletion model**: Soft-delete vs hard-delete vs retirement for GDPR compliance
- **Distributed replay protection**: Clock skew, multi-region, concurrent update conflict resolution

### Gemini 3.1 Pro — Novel Architectural Insight
- **Signature vs Selective Disclosure Paradox**: Signing the full payload then stripping fields by visibility tier makes verification impossible. SD-JWT or Merkle tree selective disclosure is needed.
- This is the **single most important finding** across both review teams — neither the 8-agent Claude panel nor the other models caught it.

### Grok 4.1 Fast — Practical Implementation Details
- **Non-instar human approval gap**: Section 7 bypasses the human review gate
- **"Trusted" tier undefined**: No IQS band thresholds, no definition of "interacted with"
- **SSI/DID/VC ecosystem alignment**: Profiles could be expressed as W3C Verifiable Credentials

---

## Divergence

Minimal divergence. All three models agree the spec is strong. Differences are in emphasis:
- GPT focuses on protocol-level correctness (identity semantics, distributed systems)
- Gemini focuses on cryptographic architecture (selective disclosure, Merkle trees)
- Grok focuses on practical implementation gaps (band definitions, format specs)

---

## Combined Recommendations (Prioritized)

1. **Resolve selective disclosure paradox** (Gemini) — Sign full payload but use SD-JWT or Merkle proofs for tiered serving
2. **Fix agent_id / key rotation contradiction** (GPT, Grok) — Stable logical ID above signing key
3. **Define signed vs unsigned Discovery Card fields** (All 3) — Split agent-signed + registry metadata
4. **Standardize visibility model** (GPT) — Remove singular visibility, use field_visibility only
5. **Lock timestamp format** (Grok) — Exactly YYYY-MM-DDTHH:MM:SSZ, no milliseconds
6. **Define IQS band thresholds and "interaction"** (Grok) — Needed for trusted tier enforcement
7. **Add distributed replay semantics** (GPT) — Clock skew tolerance, conflict resolution
8. **Three-state deletion model** (GPT) — Soft-delete, hard-delete, retirement
9. **Consider SD-JWT or W3C VC format** (Gemini, Grok) — Ecosystem compatibility
10. **Add global write rate limiting** (Gemini) — Thundering herd protection

---

## What The Cross-Model Team Found That Claude Didn't

1. **Selective disclosure paradox** — The most architecturally significant finding of the entire review process
2. **agent_id = SHA-256(pubkey) identity contradiction** with key rotation
3. **Visibility model schema inconsistency** (singular vs field_visibility)
4. **Three-state deletion model** for GDPR
5. **SSI/VC ecosystem alignment** opportunity

These demonstrate the value of cross-model review — different training data and reasoning patterns surface fundamentally different blind spots.

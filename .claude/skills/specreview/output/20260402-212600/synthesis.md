# SpecReview Synthesis — Round 7

**Review ID**: 20260402-212600
**Date**: 2026-04-02
**Spec**: Unified Threadline x MoltBridge x Instar (v0.6.0)
**Reviewers**: Security, Adversarial, Marketing, Business
**Round**: 7 (targeted verification of v0.6.0 fixes)
**Prior Round Score**: 7.9/10

---

## Overall Status: NEEDS WORK (minor — two P1 fixes remain)

Two reviewers APPROVE (Security 9.2, Marketing 9.0). Two reviewers CONDITIONAL (Business 8.8, Adversarial 8.2). Business issue was a labeling fix already applied. Adversarial found two P1 residual gaps in the v0.6.0 fix text — both are one-sentence additions.

---

## Score Summary

| Reviewer | Score | Status | Prior Score (R6) | Delta |
|----------|-------|--------|------------------|-------|
| Security | 9.2 | APPROVE | 8.5 | +0.7 |
| Marketing | 9.0 | APPROVE | 7.8 | +1.2 |
| Business | 8.8 | CONDITIONAL | 7.5 | +1.3 |
| Adversarial | 8.2 | CONDITIONAL | 7.8 | +0.4 |
| **Average** | **8.8** | | **7.9** | **+0.9** |

---

## v0.6.0 Fix Verification Summary

All 10 Round 6 P0/P1 fixes verified as present in spec text:

| Fix | Security | Adversarial | Marketing | Business |
|-----|----------|-------------|-----------|----------|
| XChaCha20-Poly1305 for key-at-rest | RESOLVED | — | — | — |
| node-forge CVE prohibition | RESOLVED | — | — | — |
| Delegation depth issuer-signed | RESOLVED | RESOLVED WITH GAP | — | — |
| Recovery notification network-independent | — | RESOLVED WITH GAP | — | — |
| Blinded attestation k=5 + jitter | — | RESOLVED (clean) | — | — |
| Proof-of-AI Sybil deposit | — | RESOLVED WITH GAP | — | — |
| Pact/Weave/Attestr blocked | — | — | RESOLVED | — |
| x402 volume corrected | — | — | — | RESOLVED |
| Neo4j costs corrected | — | — | — | RESOLVED |
| Founding agent terms clarified | — | — | — | RESOLVED |

---

## Remaining Issues (post-inline fixes)

### Already fixed during this round:
- Business break-even label ($180 not in self-hosted range) — corrected to ~9-52 agents
- A7-N1: Delegation depth key rotation ambiguity — one sentence added (fail-closed on unverifiable signatures)
- A7-N3: Cross-verification enforcement wired into Section 3.8, deposit amounts reconciled ($0.10 wallet min vs $1.00 discovery deposit)
- Arbor and Bond naming candidates blocked per Marketing research
- Naming action items updated to reflect Sigil + Kith only

### Deferred (not blocking):
- A7-N2: Local recovery alert file not append-only (LOW, P2 hardening)
- 100ms fast-solver PoW threshold still hardware-absolute (persistent across 3 rounds)
- legacyFingerprints visibility not clarified (persistent across 2 rounds)
- Clock skew +/-30s on single-use tokens (persistent, LOW)

---

## Score Trajectory

Round 1: 6.7 -> Round 2: 8.27 -> Round 3: 9.03 -> Round 4: 8.0 -> Round 5: 8.05 -> Round 6: 7.9 -> Round 7: **8.8**

With the inline fixes applied during Round 7 (delegation depth key rotation, cross-verification enforcement, break-even label, naming updates), projected score is **9.0-9.3**.

---

## Milestone: First APPROVEs

Round 7 produced the first APPROVE verdicts in the spec's review history:
- **Security: APPROVE** (9.2) — all crypto architecture verified sound
- **Marketing: APPROVE** (9.0) — naming discipline restored, competitive positioning strong

This leaves only Adversarial and Business as CONDITIONAL, both with minor residual items.

---

## What Remains for Full Approval

1. Adversarial needs to verify the inline fixes applied during Round 7 (delegation depth key rotation, cross-verification enforcement location). These were applied based on the reviewer's own recommendations — verification should be straightforward.

2. Business needs to verify the break-even label correction. Already applied.

3. The persistent 100ms fast-solver PoW threshold should be explicitly marked as a known limitation with a Phase 6 resolution timeline to prevent it from recurring in every review round.

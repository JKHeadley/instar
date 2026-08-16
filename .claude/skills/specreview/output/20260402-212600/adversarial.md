# Adversarial Review — Round 7 (v0.6.0 Fix Verification)

**Review ID**: 20260402-212600
**Spec**: Unified Threadline x MoltBridge x Instar (v0.6.0)
**Reviewer**: Adversarial (Red Team)
**Round**: 7
**Prior Score**: 7.8/10

## Approval Status: CONDITIONAL

Four of six fixes correctly implemented. Two residual gaps found. No new P0s.

## Fix Verification

| Issue | Status | Bypass Found |
|---|---|---|
| A6-C1: Delegation depth grant-hop | RESOLVED WITH GAP | A7-N1: key rotation invalidates depth cap signature |
| A6-C2: Recovery notification DoS | RESOLVED WITH GAP | A7-N2: local file deletable by filesystem adversary (LOW) |
| A6-C3: Blinded attestation timing | RESOLVED | None — clean fix |
| A6-C4: Proof-of-AI Sybil defense | RESOLVED WITH GAP | A7-N3: cross-verification enforcement location unspecified |

## New Issues

### A7-N1: Depth Cap Signature Revocation Ambiguity (MEDIUM, P1)
After key rotation, grants signed by old key have unverifiable `max_delegation_depth`. Spec doesn't specify fail-open vs fail-closed.
**Fix**: One sentence — grants from rotated-but-not-compromised keys remain valid for TTL; emergency-revoked keys invalidate grants immediately; unverifiable depth = DENY.

### A7-N2: Local Alert File Not Attack-Resistant (LOW, P2)
Filesystem adversary can delete recovery-alerts.log. Bounded risk.
**Fix**: Optional hardening — append-only log semantics.

### A7-N3: Cross-Verification Gate Enforcement Location (HIGH, P1)
IQS>0.7 cross-verification in threat model table but not in POST /moltbridge/register endpoint. Also $1.00 deposit vs $0.10 wallet minimum inconsistency.
**Fix**: Add server-side enforcement to Section 3.8 + reconcile deposit amounts.

## Score: 8.2/10
+0.4 from Round 6. To reach 9.0+: fix A7-N3 + 100ms fast-solver threshold.

# Security Review — Round 7 (Fix Verification)

**Review ID**: 20260402-212600
**Date**: 2026-04-02
**Spec**: Unified Threadline x MoltBridge x Instar (v0.6.0)
**Round**: 7 — targeted verification of v0.6.0 fixes
**Prior Round Score**: 8.5/10 (Security)

---

## Approval Status: APPROVE

All Round 6 HIGH security issues are correctly resolved. The delegation depth enforcement text is the strongest it has been — issuer-signed with explicit error semantics. No new security issues introduced by the fix text. This is a clean round.

---

## Fix Verification

| Round 6 Issue | Severity | Location | Fix Verified | Notes |
|---|---|---|---|---|
| NEW-S-C1: AES-256-GCM -> XChaCha20-Poly1305 for key-at-rest | HIGH | Section 3.3.2 | RESOLVED | Fix is present and correct. Spec now reads `XChaCha20-Poly1305(key=Argon2id(...), nonce=24 bytes CSPRNG, ...)`. Justification paragraph explicitly explains why AES-256-GCM was rejected (96-bit IV birthday bound, dual-cipher audit surface). |
| NEW-S-C2: node-forge prohibition missing (CVE-2026-33895) | HIGH | Section 3.3.1 | RESOLVED | Bold prohibition paragraph present: "Do NOT use node-forge for Ed25519 operations." CVE number, CVSS score, attack mechanism (non-canonical scalar S), and safe alternative all specified. |
| A6-C1: Delegation depth issuer-signed enforcement | HIGH | Section 3.6 | RESOLVED | Full paragraph added to enforcement points. Specifies: depth counter carried as issuer-signed claim, `current_depth` signed by issuing agent, `max_delegation_depth` signed by original grantor, enforcer verifies issuer signature before allowing re-delegation, and explicit `DELEGATION_DEPTH_EXCEEDED` error (not silent drop). RFC 8693 §8 attack vector explicitly named. |
| A6-C2: Recovery notification channel network-dependent | HIGH | Section 3.10 | RESOLVED (with nuance) | Item 5 in the time-lock list now requires out-of-band channel if primary notification channels are unresponsive. |
| LOW: HKDF example info string | LOW | Section 3.3.1 | RESOLVED | Code block now shows `info = "threadline-channel-v1-enc"`. Body and example are now consistent. |
| LOW: Delegation re-attempt error semantics | LOW | Section 3.6 | RESOLVED | Explicitly specifies `DELEGATION_DEPTH_EXCEEDED` error for auditability. |
| LOW: recoverySalt non-secret clarification | LOW | Section 3.10 | RESOLVED | Correctly prevents defensive over-engineering that could make recovery impossible. |

---

## New Issues Introduced by v0.6.0 Fix Text

**None identified.**

The three fix paragraphs are tight and do not introduce new ambiguities. Specific checks:

- The XChaCha20-Poly1305 justification paragraph does not accidentally suggest AES-256-GCM is acceptable in any other context — clean.
- The node-forge prohibition correctly scopes to "Ed25519 operations," not all cryptographic uses — correct scoping, not overcorrection.
- The delegation depth enforcement paragraph introduces `current_depth` and `max_delegation_depth` as distinct signed claims. This is architecturally sound. No confusion between the two fields.
- The recovery out-of-band channel requirement is narrowly scoped to "if all primary notification channels are unresponsive" — does not create new requirements that could be misread as mandatory for all recovery operations.

---

## Observations

1. **Section 3.3.2 justification is exemplary.** The new "Why XChaCha20-Poly1305 and not AES-256-GCM" paragraph explicitly documents the birthday-bound nonce collision risk (2^48 for 96-bit IV) and the audit surface reduction argument. Future maintainers will not accidentally revert this to AES-256-GCM.

2. **Delegation depth fix closes RFC 8693 §8 cleanly.** The spec explicitly names the OAuth 2.0 actor chaining attack and its mechanism. The requirement to verify the issuer's signature on `current_depth` before allowing re-delegation is the correct enforcement point.

3. **node-forge prohibition is correctly scoped.** CVE-2026-33895 is Ed25519-specific; scoping to "Ed25519 operations" is accurate.

4. **recoverySalt clarification prevents defensive over-engineering.** Implementors who treat `recoverySalt` as secret may store it separately from `identity.json`, making recovery impossible if that separate store is unavailable.

5. **Recovery notification nuance:** The current text requires out-of-band channels only "if all primary notification channels are unresponsive." An attacker who suppresses channels during the attack window and then restores them has a brief window where the notification appears to succeed. This is theoretical — the fix is sound for v0.6.0. Future adversarial review may recommend a mandatory independent secondary channel (not just fallback), but this is not a blocker.

---

## Score: 9.2/10

**Justification:** All three HIGH issues from Round 6 are resolved with correct, specific, and well-justified text. All LOW items are closed. No regressions introduced. The score returns to the Round 5 security baseline (9.2) from the Round 6 dip (8.5). The 0.8 gap to a perfect score reflects persistent P1 items carried from prior rounds (100ms PoW hardware-absolute threshold, key rotation broadcast DoS at scale) which remain unresolved but are correctly deferred.

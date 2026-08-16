# Security Review — Round 6

**Review ID**: 20260402-204150
**Date**: 2026-04-02
**Spec**: Unified Threadline x MoltBridge x Instar (v0.5.0)
**Reviewer**: Security Specialist
**Prior Round**: Round 5 (8.05/10, all-conditional)
**Focus**: Verification of v0.5.0 fixes for S-C1, S-C2, S-C3, A-C1, A-C2

---

## Approval Status: CONDITIONAL

The v0.5.0 fixes address all Round 5 P0 issues and are cryptographically sound. One new HIGH-severity issue was identified: Section 3.3.2 uses AES-256-GCM for key-at-rest encryption when XChaCha20-Poly1305 (already in the spec) is safer and simpler. A critical research finding adds a library prohibition requirement (CVE-2026-33895 on node-forge). Both are one-line spec fixes.

---

## V0.5.0 Fix Verification

### S-C1: HKDF Salt Single-Use Mandate — RESOLVED

Section 3.3.1 now mandates that the transcript hash salt is single-use per handshake and that multiple derived keys must use distinct `info` strings. This is correct per RFC 5869 and consistent with Trail of Bits January 2025 guidance. The transcript hash as salt (both parties' ephemeral pubkeys + nonces) eliminates attacker-controlled salt risk.

**Minor refinement (LOW, not blocking)**: The main HKDF example still shows `info = "threadline-channel-v1"` while the body mandates using `"threadline-channel-v1-enc"` / `"threadline-channel-v1-mac"` for multiple keys. Implementors copy examples — the example should be updated to match the mandate.

### S-C2: Identity Private Key Encryption at Rest — RESOLVED WITH CAVEAT

Section 3.3.2 is new and well-structured. The Argon2id parameters (t=3, m=65536, p=4) match OWASP 2025 recommendations. The per-agent random salt (32 bytes CSPRNG) is correct. The passphrase policy (OS keychain for interactive, env var for headless, explicit "none" for dev) is the right threat model scoping.

**HIGH severity issue — AES-256-GCM nonce reuse risk**: A 96-bit random IV has birthday-bound collision risk at 2^48 random encryptions. While a single at-rest key encryption is safe, the spec doesn't restrict re-encryption frequency. If implementations re-encrypt on every passphrase change, key rotation step, or config update, nonce collisions accumulate. More practically: AES-256-GCM is a second cipher in the implementation when XChaCha20-Poly1305 is already specified for channel encryption — doubling cipher surface and complicating audits unnecessarily.

**Fix**: Replace `AES-256-GCM` with `XChaCha20-Poly1305` (192-bit nonce, safe for any realistic re-encryption frequency, single cipher primitive across the spec).

### S-C3: Per-Message AEAD Authentication — RESOLVED

Section 3.3.1 mandates XChaCha20-Poly1305 AEAD independently per message with unique per-message nonce. This is correct. XChaCha20's 192-bit nonce means random nonce generation is safe up to 2^96 messages before collision probability becomes meaningful. The per-message requirement prevents session-level stream reuse attacks and relay injection.

### A-C1: Argon2id Per-Agent Random Salt — RESOLVED

Section 3.10 now mandates 32 bytes of CSPRNG randomness stored as `recoverySalt` in `identity.json`, with explicit prohibition of constant salts like `"instar-recovery-v1"`. This is correct and exceeds NIST SP 800-63B's 16-byte minimum. The fix correctly addresses the rainbow table attack vector.

**LOW note**: The spec should clarify that `recoverySalt` is intentionally non-secret (salts never are) to prevent implementors from trying to protect it separately in a way that could make recovery impossible.

### A-C2: Delegation Depth Cap — RESOLVED

Section 3.6 now includes `max_delegation_depth` (default: 1) in the authorization schema with correct enforcement language. The combination of count limit (`max_sub_agents`) and depth limit is the right design. Default depth 1 (grantee cannot re-delegate) is conservative and appropriate.

**LOW note**: The spec should define error semantics when a grantee attempts re-delegation at depth 1 — silent drop vs. explicit error. Error semantics are important for auditability.

---

## Critical Issues

### NEW-S-C1: AES-256-GCM Nonce Reuse Risk (HIGH)

**Location**: Section 3.3.2

**Description**: AES-256-GCM with a 96-bit random IV introduces nonce collision risk if the key is re-encrypted multiple times. The spec doesn't bound re-encryption frequency. Additionally, AES-256-GCM is a second AEAD primitive when XChaCha20-Poly1305 is already specified for channel encryption, increasing implementation complexity and audit surface.

**Severity**: HIGH

**Fix**: One-line change — replace `AES-256-GCM` with `XChaCha20-Poly1305` and update IV to 24-byte CSPRNG nonce in Section 3.3.2.

### NEW-S-C2: node-forge Library Prohibition Missing (HIGH)

**Location**: Section 3.3.1 (library recommendations)

**Description**: CVE-2026-33895 (published March 2026, CVSS 7.5) documents that node-forge <= 1.3.1 accepts non-canonical Ed25519 signatures where scalar S is not reduced modulo the group order. This enables signature malleability that can bypass replay tracking, deduplication by signature bytes, and signed-object canonicalization checks. The spec recommends `@noble/ed25519` and `@noble/curves` but doesn't explicitly prohibit alternatives. Given that node-forge is a common alternative and now has an active signature forgery CVE, an explicit prohibition is needed.

**Severity**: HIGH

**Fix**: Add to Section 3.3.1: "Do NOT use node-forge for Ed25519 operations — CVE-2026-33895 (March 2026, CVSS 7.5) enables Ed25519 signature forgery via non-canonical scalar acceptance. `@noble/ed25519` does not have this vulnerability."

---

## Research Findings

**HKDF-SHA256**: RFC 5869 and Trail of Bits (Jan 2025) confirm the spec's HKDF usage is correct. Using the transcript hash as salt eliminates attacker-controlled salt risk. Distinct `info` strings for key separation is the canonical best practice. No advisories against HKDF-SHA256 itself.

**XChaCha20-Poly1305**: 192-bit nonce eliminates nonce reuse risk for random nonce generation at any realistic message volume (safe to 2^96 messages). The picoCTF 2025 writeup confirmed catastrophic key recovery from nonce reuse in ChaCha20-Poly1305. The spec's per-message nonce mandate directly addresses this. XChaCha20 is the correct choice over standard ChaCha20.

**Argon2id**: OWASP 2025 and NIST SP 800-63B confirm the spec's parameters (t=3, m=65536, p=4, 32-byte salt) are correct. Per-agent random salt is the correct defense against rainbow table attacks — precomputation becomes infeasible with unique salts.

**@noble/ed25519 and @noble/curves**: 6 Cure53 audits as of April 2026 with funding from OpenSats. No CVEs against noble libraries. Constant-time operations, no native dependencies. **Recommend explicitly over node-forge given CVE-2026-33895.**

**CVE-2026-33895 (node-forge, March 2026, CVSS 7.5)**: Ed25519 signature verification in node-forge <= 1.3.1 accepts non-canonical signatures (S >= L not checked). Both a signature and its S+L variant verify in node-forge, while OpenSSL-backed implementations correctly reject the S+L variant. Impact: authentication bypass, replay tracking failure, canonicalization bypass. Fixed in node-forge 1.4.0. Noble/ed25519 is not affected.

**X25519 forward secrecy**: X25519 with ephemeral keypairs per session provides perfect forward secrecy. The spec's transcript hash binding (both parties' ephemeral public keys + nonces) correctly prevents cross-session key material reuse. Current 2025 best practice recommendation: X25519 ephemeral + Ed25519 authentication + HKDF-SHA256 + XChaCha20-Poly1305, which exactly matches the spec.

---

## Recommendations

**Priority 1 — Fix before implementation**

1. Replace `AES-256-GCM` with `XChaCha20-Poly1305` in Section 3.3.2 (NEW-S-C1, HIGH)
2. Add explicit node-forge prohibition citing CVE-2026-33895 to Section 3.3.1 (NEW-S-C2, HIGH)

**Priority 2 — Fix before Phase 1 code**

3. Update HKDF `info` string in the example to `"threadline-channel-v1-enc"` for consistency with the mandate (LOW)
4. Specify delegation re-attempt error semantics in Section 3.6 (LOW)
5. Clarify `recoverySalt` is intentionally non-secret in Section 3.10 (LOW)

**Priority 3 — Phase 6 hardening**

6. Replace absolute 100ms fast-solver PoW threshold with percentile-based detection (carried from Round 5)
7. Key rotation broadcast pagination for large contact lists (10K+ contacts = DoS vector at scale)

---

## Observations (Well-Implemented)

- Transcript hash binding in HKDF is correctly specified with both parties contributing
- Credibility packet constraints (pre-auth hint, not handshake replacement; JWT bound to audience/nonce/TTL/session) are correct
- Recovery time-lock (24h + cancellation + human confirmation + 3/day rate limit) is appropriate defense-in-depth for social engineering
- Attestation blinding with k-anonymity (0.8x weight) elegantly solves retaliation suppression
- Role-separation framing for incoming agent messages (Section 3.14) is the correct mitigation for trusted-channel prompt injection
- Circuit breaker on MoltBridge enrichment and manual default enrichment mode correctly minimize contact graph disclosure
- Sybil protection layering (PoW + IP rate limiting + identity aging + per-target receive limits + fast-solver throttling) is well-designed

---

## Scalability Assessment

At MVP scale (<500 agents), security posture is strong. At 10K+ agents:

- **Key rotation broadcast**: Broadcasting to all contacts simultaneously at 10K+ contacts is a DoS vector. Gossip protocol or pagination needed by Phase 7.
- **Attestation graph density**: Louvain community detection at 50K agents with millions of edges is computationally expensive. Neo4j super-node mitigation (noted in Phase 6) needs to cover attestation graph complexity too.
- **IQS cache coherence**: 1-hour cache staleness is acceptable at 500 agents. At relay scale with shared infrastructure, coordinated cache poisoning of high-IQS compromised agents needs a targeted invalidation mechanism.
- **PoW epoch transitions**: 10-minute epoch with >1h uptime exemptions is appropriate for MVP. At relay scale, coordinated submission of pre-computed PoW during epoch transitions needs explicit handling.

---

## Score: 8.5/10

All Round 5 P0 fixes are verified correct. The AES-256-GCM choice in Section 3.3.2 and the missing node-forge prohibition (given CVE-2026-33895) prevent a move to APPROVE. Both are one-line spec fixes. With those two changes, this spec would score 9.3+ and APPROVE. The underlying cryptographic architecture — X25519 ephemeral + HKDF-SHA256 + XChaCha20-Poly1305, Argon2id with per-agent random salt, delegation depth caps, three-layer trust with deterministic policy enforcement — is sound and well-specified.

---

## Sources

- [Best practices for key derivation — Trail of Bits (Jan 2025)](https://blog.trailofbits.com/2025/01/28/best-practices-for-key-derivation/)
- [RFC 5869 — HKDF](https://datatracker.ietf.org/doc/html/rfc5869)
- [XChaCha20-Poly1305 — Libsodium](https://libsodium.gitbook.io/doc/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction)
- [Breaking ChaCha20-Poly1305: Nonce Reuse — Zeroday Academy (picoCTF 2025)](https://zeroday.academy/breaking-chacha20-poly1305-exploiting-nonce-reuse-in-picoctf-2025/)
- [Argon2id Password Security 2025 — Medium](https://medium.com/@sumanbhadrasuman/password-security-in-2025-why-argon2id-is-the-standard-you-should-use-7c0797349836)
- [Noble cryptography audit history](https://paulmillr.com/noble/)
- [CVE-2026-33895 — GitLab Advisories](https://advisories.gitlab.com/pkg/npm/node-forge/CVE-2026-33895/)
- [digitalbazaar/forge Ed25519 forgery advisory](https://github.com/digitalbazaar/forge/security/advisories/GHSA-q67f-28xg-22rw)

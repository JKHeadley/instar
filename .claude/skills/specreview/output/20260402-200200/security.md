# Security Review — Round 5

### Approval Status: CONDITIONAL APPROVE

**Score: 9.2 / 10**

**Verification of Prior P0 Items**: Both P0 items from the prior round 5 review (20260329-171842) remain unresolved in v0.4.0:
1. HKDF salt single-use mandate — still missing from Section 3.3.1
2. Identity private key encryption scheme — still undefined in Section 3.3

---

### Critical Issues

**C1 — HKDF Salt Single-Use Mandate Missing (HIGH, Phase 0 gate)**
Section 3.3.1 does not state that the transcript hash salt is single-use per handshake and that additional key derivations must use distinct `info` strings. An implementer who derives both encryption and MAC keys with the identical `(salt, IKM, info)` tuple produces the same key for both, collapsing key separation. Fix: one sentence — "Each (session, purpose) pair MUST use a distinct `info` string. The transcript_hash salt is single-use per handshake."

**C2 — Identity Private Key Encryption Scheme Undefined (HIGH, Phase 0 gate)**
`identity.json` says `"privateKey": "<Ed25519 private key, base64, encrypted at rest>"` but specifies no algorithm, no passphrase derivation, no headless-agent guidance. The "stolen key attacker" threat entry assumes filesystem read is insufficient — that assumption only holds if the key is actually encrypted. Fix: add Section 3.3.2 specifying AES-256-GCM + Argon2id-derived passphrase for interactive agents, OS keychain for interactive agents, explicit guidance for headless.

**C3 — Per-Message AEAD Authentication Ambiguity (MEDIUM, Phase 2 gate — NEW)**
OWASP 2026 ASI07 specifies mutual authentication for inter-agent channels. The spec's XChaCha20-Poly1305 provides authentication if applied per-message, but the spec is ambiguous about whether AEAD is per-message or per-session. If per-session only, a relay-level MITM can inject message frames within an established session. Fix: one clarifying sentence in Section 3.3.1 confirming AEAD is applied to each message independently.

---

### Recommendations

- **R1** (HIGH, Phase 4): Wallet private key encryption at rest unspecified in `wallet.json`
- **R2** (MEDIUM, Phase 4): MCP tool descriptions must be static strings, not API-populated — addresses documented 30+ CVE tool poisoning attack pattern
- **R3** (LOW-MEDIUM, Phase 3): Redeemed-tokens set persistence location undefined
- **R4** (LOW, Phase 5): JWT audience claim verification not explicit in Section 3.9
- **R5** (MEDIUM, Phase 6): Relay HA security state replication gaps (PoW epoch sync, token replication, rate-limit state)

---

### Research Findings

- **HKDF-SHA256/X25519**: No new cryptographic vulnerabilities found (Trail of Bits Jan 2025, RFC 9709). Spec's derivation is correct. Only risk is implementation-level salt reuse (C1).
- **Ed25519 key management**: Hardware security modules / FIDO2 integration recommended for high-value keys. Co-location of identity + wallet key is the documented high-risk configuration.
- **Trust graph attacks**: Sparse collusion (loosely-connected mutual attestation pairs) is a known weakness of Louvain community detection. Partially mitigated by cross-verification weighting but worth documenting.
- **Prompt injection framing**: 2025 research achieved 100% mitigation with dual-LLM quarantine (Privileged + Quarantined LLM), stronger than framing alone. Spec's approach is adequate for Phase 0–5; dual-LLM quarantine is the Phase 6+ upgrade path.
- **MCP tool poisoning**: 30+ CVEs confirmed by March 2026. WhatsApp MCP server exploited via tool description injection. R2 directly addresses this attack vector.
- **BIP-39 recovery**: No cryptographic weaknesses. Social engineering is the primary attack vector; spec's 24-hour time-lock is the correct primary defense.

---

### Scalability Assessment

- **Phase 1–3**: Architecture is solid. C1/C2 are documentation fixes only.
- **Phase 4 (500 agents)**: Manageable with R1+R2 resolved. Denial-of-Wallet DoS is well-mitigated.
- **Phase 5–6 (2K agents)**: Sparse collusion may cause IQS distortions; relay HA needs R5 before multi-instance.
- **Phase 7+ (5K+ agents)**: Relay HA and Neo4j federation are the dominant security concerns.

# Security Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-153601
**Reviewer**: Security
**Round**: 4
**Date**: 2026-03-29

---

### Approval Status: CONDITIONAL APPROVAL

### Score: 8.7/10

**Justification**: Score is a slight regression from Round 3 (9.03) because independent research surfaced two issues not visible in prior rounds — the missing KDF specification between X25519 and XChaCha20, and trusted-channel prompt injection. All P0 items from prior rounds are resolved. Remaining issues are P1/P2 level.

---

### Research Findings

**Ed25519**: The MystenLabs registry documents 40+ libraries with unsafe implementations. The spec never names the Ed25519 library to be used — a consequential omission. CVE-2024-30172 (Bouncy Castle DoS via crafted signature) and a 2025 wolfSSL fault injection disclosure are relevant to production deployments.

**XChaCha20-Poly1305**: Sound choice — 192-bit nonces eliminate nonce-reuse risk, 4.2ms performance vs 8.9ms for AES-GCM. Critical gap: the spec specifies X25519 + XChaCha20 but never specifies the KDF step between them. Raw X25519 output is not a uniform key and must be processed through HKDF before use.

**Multi-Agent Prompt Injection**: OWASP LLM Top 10 2025 ranks prompt injection #1. 2025 academic research documents "Inter-Agent Trust Exploitation" with 100% success rate — LLMs that resist direct injection execute identical payloads from trusted peer agents. CVE-2025-53773 (GitHub Copilot RCE via prompt injection) was published this year.

**Reputation Graph Poisoning**: Sybil-resistant reputation systems require graph-topology-level detection (Sybil-Guard, SybilLimit), not just edge weighting. MoltBridge's anomaly detection is referenced but never specified.

**Wallet Co-location**: The "non-custodial" wallet key lives in `.instar/moltbridge/wallet.json` alongside the identity key. One file system compromise yields both identity and financial assets.

---

### P1 — Critical (Must Fix Before Phase 2)

**P1-A: Missing KDF Specification** (Section 2, 3.3, 3.9)

The spec specifies X25519 key agreement and XChaCha20-Poly1305 AEAD but never defines the key derivation step between them. The X25519 shared secret is not a uniform key — it must go through HKDF (or equivalent). Naive implementations using the raw shared secret produce cryptographically weak encryption.

**Fix**: Either cite Noise_XX/Noise_IK explicitly as the handshake pattern, or specify `symmetric_key = HKDF-SHA256(salt=transcript_hash, IKM=X25519_shared_secret, info="threadline-channel-v1")`. This must be covered by Phase 0 test vectors.

**P1-B: Trusted-Channel Prompt Injection** (Section 3.1, 3.6, 4.1)

The spec defends against Agent Card injection (good) but misses the broader attack class: an attacker who compromises a `verified` or `trusted` peer agent can deliver prompt injection payloads in the *body* of relay messages. Research shows 100% success rate for this vector — the LLM treats peer messages as trusted input. The spec's current defenses (deterministic policy enforcement, Agent Card sanitization) do not cover message content injection.

**Fix**: Add "Trusted-channel prompt injection" to the threat model. Add an enforcement requirement that incoming agent message content is framed with explicit role separation in LLM context to prevent instruction injection. Add a Phase 6 hardening item for message content isolation.

---

### P2 — Should Fix Before Phase 3

**P2-A: Wallet and Identity Key Co-location** (Section 3.8) — `wallet.json` and `identity.json` in the same directory. Single compromise yields both. Fix: Store only wallet address in `wallet.json`, not the private key, or derive the wallet encryption key from the user's recovery phrase separately from the agent's Ed25519 key.

**P2-B: Clock Skew Creates Replay Window** (Section 4.3) — ±30s tolerance = 60s replay window for PoW solutions. Fix: Server-side seen-set for PoW solutions within the epoch window. Atomic invitation redemption check. Reduce skew tolerance to ±15s to match the warning threshold already in the spec.

**P2-C: Recovery Phrase Entropy Unspecified** (Section 3.10) — Format, entropy level, and derivation function for the recovery phrase are not defined. Headless agents storing recovery phrases in config files have weaker guarantees than the spec implies. Fix: Define BIP-39 + PBKDF2/Argon2id derivation in Phase 0 test vectors. Add headless deployment warning.

**P2-D: `migrationStatus: "active"` Public Exposure** (Section 3.10) — Broadcasting migration status in the public Agent Card signals to attackers that the agent is in a transitional state and creates a window for forged migration-complete messages. Fix: Keep `migrationStatus` in authenticated channels only, not the public `.well-known/agent.json`. Migration completion notifications must also require dual-signatures.

**P2-E: Relay Unavailability Blocks Cross-Network Trust Bootstrap** (Section 3.4, 3.5) — The closed-by-default + invitation-required model depends on the relay for cross-network invitation delivery. If the relay is down, two agents that have never met cannot establish trust. Fix: Specify the direct-connection fallback for invitation redemption. Clarify whether MoltBridge broker paths can serve as fallback delivery channel.

---

### P3 — Observations

- **O1**: Ed25519 library unspecified — for Node.js, `@noble/ed25519` is the reference implementation. Name it in Phase 0.
- **O2**: Targeted attestation spam (100 `failure` attestations from fresh identities against one target) is not addressed. Flag to MoltBridge's trust scoring team.
- **O3**: `autonomous-within-scope` delegation policy name overlaps with the deprecated `autonomous` trust level — consider renaming to `scoped-delegation` to prevent implementation confusion.
- **O4**: Proof-of-AI challenge mechanism is never specified. If it can be spoofed, MoltBridge-discovered agents start at `verified` on weaker grounds than described.
- **O5**: No rate limit on `POST /moltbridge/attest`. A `verified` agent can submit volume attestations to game the IQS graph.
- **O6**: Audit log hash chain details (primitive, signing key separation, corruption recovery) are unspecified for Phase 6.

---

### Scalability Assessment (Security Lens)

- **Phase 1 (MVP)**: Security posture is strong for small-scale deployment. Ed25519 + XChaCha20 is well-chosen.
- **Phase 2 (Growth, 10x)**: Key rotation broadcast to hundreds of contacts is unreliable — add pull-based revocation check before each new grant issuance as a backup.
- **Phase 3 (Scale, 100x)**: Auto-enrichment queries to MoltBridge grow O(N) with new connections and may hit API rate limits — specify a per-hour cap on automatic enrichment queries.
- **Viral spike handling**: PoW + identity aging provides reasonable protection. Main concern is trusted-channel prompt injection at scale — one compromised popular agent could cascade.

---

*Generated by SpecReview Security Reviewer, Round 4.*

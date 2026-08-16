# Security Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-171842
**Date**: 2026-03-29
**Round**: 5
**Reviewer**: Security Specialist
**Spec**: specs/unified-threadline-moltbridge-instar.md (v0.4.0)
**Prior Round**: Round 4 synthesis (20260329-153601)

---

## Approval Status: CONDITIONAL APPROVE

**Score: 9.1 / 10** (up from 8.7 in Round 4)

The v0.4.0 revision has resolved all Round 4 P0 security items. The HKDF-SHA256 specification is now present, correct, and includes test vector requirements. The trusted-channel prompt injection threat is documented and defended. Recovery fraud protection is specified with appropriate time-locks. The remaining security concerns are narrower and do not block Phase 0-3 implementation — but several must be addressed before Phase 4 (MoltBridge integration) and Phase 5 (production bridge).

---

## Research Findings

### HKDF-SHA256 + X25519 + XChaCha20 (Trail of Bits, January 2025)

Trail of Bits published a comprehensive guide on KDF best practices confirming: (1) the HKDF salt cannot be attacker-controlled, (2) using HKDF over raw X25519 output is the correct approach, (3) Signal and Noise both use HKDF internally when deriving session keys from shared secrets. The spec's derivation matches this guidance. One nuance from the research: **the spec uses `transcript_hash` as the HKDF salt**, which is correct and binding, but the spec should explicitly state that the salt is computed fresh per-session and that reuse of a transcript hash across sessions would be catastrophic. This is implied but not stated.

### Prompt Injection via Inter-Agent Trust (OWASP 2025, eSecurity Planet 2026)

Prompt injection is ranked #1 in OWASP's 2025 LLM Top 10. Research documented in Q4 2025 shows agentic workflows are the primary exploitation target. The dual-LLM quarantine approach (Privileged + Quarantined LLM) has emerged as a more robust defense than framing alone — the spec uses framing but not full LLM quarantine. The spec's Section 3.14 defense is sound but represents one layer of a recommended three-layer approach. The spec acknowledges this as a known limitation.

### A2A Agent Card Security (Solo.io, Practical DevSecOps 2026)

A critical finding from current research: **A2A Agent Cards do not have a cryptographic signature standard** at the protocol level. Attackers can forge or inject malicious instructions into agent card metadata fields (descriptions, skills). The spec addresses this by sanitizing capability descriptions before LLM input and noting that "Agent Card content is never used in trust/auth decisions" — but the Agent Card served at `/.well-known/agent.json` could itself be served from a compromised intermediary without the receiver detecting tampering. The spec relies on Ed25519 challenge-response handshake to confirm identity, which correctly sidesteps the unsigned-card problem.

### MCP Tool Poisoning (30+ CVEs as of March 2026)

MCP has accumulated 30+ CVEs with documented real-world breaches. The spec exposes 3 MCP tools via the Threadline MCP server (`moltbridge_discover`, `moltbridge_trust`, `moltbridge_attest`). Tool descriptions injected into LLM context are an active attack surface. The spec does not address potential malicious tool description injection from a compromised MoltBridge API response that populates MCP tool metadata.

### BIP-39 + Argon2id Recovery Key Derivation

The mnemonikey project (referenced in research) uses Argon2id + HKDF internally — confirming the spec's approach is sound. The Argon2id parameters in the spec (t=3, m=65536, p=4) are reasonable but slightly below modern recommendations for high-security key derivation (OWASP 2025 recommends m=64MB minimum for interactive, m=256MB for high-security). At m=65536 (64MB), the spec is at the minimum recommended threshold — adequate but conservative. This is not a blocker but worth documenting.

### Non-Custodial Wallet Private Key Security

Research confirms non-custodial software wallets co-located with runtime state are the highest-risk configuration. The spec stores `wallet.json` in `.instar/moltbridge/wallet.json` — co-located with agent runtime state. If the filesystem is compromised, both the identity private key and the wallet private key are exposed simultaneously. The Round 4 P2 recommendation to "separate wallet private key from identity key storage" remains unresolved.

---

## Resolution of Round 4 P0 Items

| P0 Item | Round 4 Status | Round 5 Status |
|---------|---------------|---------------|
| #1: HKDF-SHA256 KDF specification | MISSING | **RESOLVED** — Section 3.3.1 fully specified with parameters, transcript hash, test vector requirements, and Noise pattern alternative |
| #8: Trusted-channel prompt injection in threat model | MISSING | **RESOLVED** — Section 3.14 adds role-separation framing, Section 4.1 adds threat actor class |
| #3: Recovery operation 24-hour time-lock | MISSING | **RESOLVED** — Section 3.10 specifies time-lock, cancellation window, notification, human confirmation, rate limiting |
| #4: Hard migration deadline (30 days) | UNSPECIFIED | **RESOLVED** — Section 3.10 specifies 30-day deadline with enforcement mechanism and rationale |
| #7: Attestation capability tag vocabulary | UNDEFINED | **RESOLVED** — Section 3.13.1 defines controlled vocabulary with 8 categories, proposal mechanism |
| #6: Attestation retaliation suppression | UNADDRESSED | **RESOLVED** — Section 3.13.1 adds blinded attestation option with k-anonymity and anomaly detection |

All 6 P0 security items from Round 4 are resolved. This is a clean sweep.

---

## Critical Issues

### C1 — HKDF Salt Freshness Not Explicitly Mandated
**Severity: HIGH (Phase 0 gate)**
**Section**: 3.3.1

The spec correctly defines `transcript_hash` as the HKDF salt and specifies it as `SHA-256(initiator_ephemeral_pubkey || responder_ephemeral_pubkey || initiator_nonce || responder_nonce)`. However, it does not explicitly state that this salt MUST be unique per session and MUST NOT be reused. If an implementation reuses transcript hash material (e.g., deriving multiple keys from the same handshake without modifying the info string), the same symmetric key would be produced for different purposes.

**Concrete risk**: If the implementation derives both an encryption key and an authentication key using the same `(salt, IKM, info)` tuple, key separation breaks. The `info` string "threadline-channel-v1" prevents cross-system reuse, but does not prevent intra-session reuse if developers derive additional keys without modifying `info`.

**Fix**: Add one sentence: "Each unique (session, purpose) pair MUST use a distinct `info` string. The salt (transcript_hash) is single-use per handshake — never reuse transcript material across sessions."

**Note**: This is a documentation gap, not a design flaw. The existing design is correct; the spec just needs to close the implementation loophole.

---

### C2 — Wallet Private Key Co-Location Risk (P2 from Round 4, Now Escalated)
**Severity: HIGH (Phase 4 gate)**
**Section**: 3.8

The wallet key in `.instar/moltbridge/wallet.json` is co-located with the identity private key in `.instar/identity.json`. The Round 4 security review flagged this as P2. After examining the wallet key's attack surface more carefully, this warrants escalation to P1 before Phase 4:

- Both keys are in the same filesystem directory
- Both keys are protected by the same file-system access controls
- A single filesystem compromise exposes the agent's identity AND its funds simultaneously
- The spec notes wallet private keys should be encrypted at rest, but the spec does not define the encryption scheme for `wallet.json` (unlike `identity.json` which has `identity-backup.enc`)

**Specific gap**: Section 3.8 defines `wallet.json` contents but does not specify whether the wallet private key is stored encrypted or plaintext. If plaintext, a read of the filesystem dumps spendable USDC funds.

**Fix**: (a) Define wallet.json encryption at rest (recommend same approach as identity key). (b) Add a note discouraging co-location: recommend storing wallet key outside the `.instar/` directory when possible, or using a hardware signer for agents with significant USDC balances.

---

### C3 — MCP Tool Description Injection from Compromised MoltBridge API
**Severity: MEDIUM (Phase 4 gate)**
**Section**: 3.8 (MCP tools), 3.14

The spec adds 3 MCP tools: `moltbridge_discover`, `moltbridge_trust`, `moltbridge_attest`. When the Instar server exposes these tools to a Claude Code session, the tool descriptions are injected into the LLM context window. If a compromised or spoofed MoltBridge API response modifies the Instar server's local tool registry, injected tool descriptions become an injection vector.

Current research (30+ CVEs, tool poisoning documented in MCP ecosystem) confirms this is an active exploitation pattern in 2026.

**Specific scenario**: Attacker performs MITM on Instar ↔ MoltBridge API communication. Returns crafted capability descriptions that include injection payloads. These descriptions propagate into MCP tool definitions exposed to the agent's LLM context.

**Current mitigation**: Section 3.14 sanitizes "capability descriptions in discovery results: max 200 characters, alphanumeric + basic punctuation only." This applies to discovered agents' capability descriptions. It is unclear whether the same sanitization applies to MoltBridge API response content that populates MCP tool descriptions.

**Fix**: Explicitly state that MoltBridge API response fields that feed into MCP tool descriptions are subject to the same sanitization rules as agent capability descriptions (Section 3.14). MCP tool descriptions should be static strings defined in the Instar codebase, not populated dynamically from API responses.

---

### C4 — Clock Skew Window Creates Token Replay Opportunity
**Severity: LOW-MEDIUM (Phase 0 gate)**
**Section**: 4.3 (Security Invariants)

The spec defines ±30-second clock skew tolerance for all TTL-based checks. Invitation tokens have `maxUses: 1` semantics and are stored in a redeemed-tokens set. However, if two instances of the same agent (e.g., during a failover or split-brain) each have an empty redeemed-tokens set, and both operate within the 30-second window, a token presented to both could be accepted twice.

**Concrete scenario**: Token expires at T+30. Instance A goes offline at T+25. Instance B comes online at T+28 (stale redeemed-tokens set). Attacker presents token to Instance B at T+29 — accepted (Instance B doesn't know Instance A already redeemed it).

**Current mitigation**: The spec has no discussion of redeemed-tokens set persistence or split-brain handling.

**Fix**: Require redeemed-tokens set to be persisted to disk before accepting a token (synchronous write, not in-memory only). Define the redeemed-tokens set as part of the agent's state directory (`.instar/threadline/redeemed-tokens.json`). Add a note that agents with multiple instances must treat token redemption as a critical section.

This is LOW severity for single-instance deployments (the common case), but MEDIUM for clustered or HA agent deployments. Given the relay HA design is planned for Phase 7, flag now.

---

## Observations (Non-Blocking)

### O1 — Transcript Hash Collision Resistance Reliance
**Section**: 3.3.1

The transcript hash uses SHA-256, which provides 128-bit collision resistance. This is adequate for current standards but the spec should note that transcript hash fields should never be user-controlled. Specifically: if `initiator_nonce` or `responder_nonce` could be chosen by an attacker (via a compromised peer), they cannot force a collision due to SHA-256's preimage resistance, but they could attempt length-extension attacks if the transcript is processed with a non-HMAC hash. HKDF's extract step uses HMAC-SHA256 internally, which prevents length-extension. This is correct — but worth documenting explicitly for implementers who might be tempted to substitute SHA-256 directly.

### O2 — Argon2id Parameters Adequate but Minimum
**Section**: 3.10

Recovery keypair derivation uses `Argon2id(t=3, m=65536, p=4)`. OWASP 2025 recommends t=1, m=64MB minimum for interactive contexts and t=1, m=256MB for high-security contexts. The spec's parameters (t=3, m=64MB) exceed the interactive minimum on time but are at the minimum on memory. For key derivation (not login), higher memory (m=256MB) would better protect against GPU-based brute force. However, this creates a usability issue on memory-constrained headless agents. The tradeoff is acceptable; the spec should document it explicitly alongside the headless deployment warning it already includes.

### O3 — Recovery Phrase Storage Guidance Incomplete
**Section**: 3.10

The spec includes a "Headless deployment warning" about recovery phrase storage but does not recommend a specific storage mechanism for interactive (human-operated) agents. Best practices (hardware key storage, encrypted password manager, physical backup) are unaddressed. For agents operated by non-technical users, this gap may lead to insecure storage (plaintext file, email to self, etc.).

**Fix**: Add 2-3 concrete recommendations for recovery phrase storage in the headless warning section.

### O4 — JWT Binding for Credibility Packets: Audience Binding Completeness
**Section**: 3.9

The spec mandates JWT binding to: audience (recipient fingerprint), nonce (per-session), short TTL (5 min), session ID. The nonce-per-session binding is good. However, the spec does not specify what prevents an agent from replaying a valid JWT to a different recipient before the 5-minute TTL expires. The audience binding (recipient fingerprint) should prevent this — but the spec does not explicitly state that the verifying party must check the `aud` claim against their own fingerprint. This is an implementation gotcha that should be stated explicitly: "The recipient MUST verify that the JWT `aud` claim matches their own fingerprint before accepting the credibility packet."

### O5 — Phase 6 Relay HA Design Gap
**Section**: Phase 6

The spec correctly defers relay HA implementation to Phase 7 but requires the design in Phase 6. The design references "Redis Pub/Sub backplane" but does not specify: (a) how invitation tokens in the redeemed-tokens set are replicated across relay instances, (b) how the PoW epoch is synchronized across relay instances to prevent same-epoch solution reuse, and (c) how the FTS5 directory is replicated. These are security-relevant gaps in the HA design specification.

### O6 — Identity File Private Key Encryption "At Rest" Undefined
**Section**: 3.3

The `identity.json` specifies `"privateKey": "<Ed25519 private key, base64, encrypted at rest>"` but does not define the encryption scheme. The spec specifies `identity-backup.enc` exists as an encrypted backup but does not link the two. Questions: (a) What encrypts the private key in `identity.json`? A passphrase? The OS keychain? (b) Is the encryption passphrase stored separately from the key? (c) For headless agents, is the key stored encrypted or plain? This gap affects threat model accuracy — "key compromised" scenario assumes the attacker needs the recovery phrase, but if the key is stored plain in `identity.json`, filesystem read access is sufficient.

**This should be specified before Phase 0 implementation.**

---

## Recommendations

### P0 — Must Fix (Phase 0 Gate)

| # | Issue | Fix | Effort |
|---|-------|-----|--------|
| 1 | HKDF salt freshness — no explicit per-session uniqueness mandate | Add sentence to Section 3.3.1: salt is single-use per handshake, additional key derivations must modify info string | Low |
| 2 | Identity private key encryption undefined in identity.json | Specify encryption scheme for private key at rest in identity.json. Recommend OS keychain for interactive, AES-256-GCM with passphrase for headless | Low |

### P1 — Before Phase 4 (MoltBridge Integration Gate)

| # | Issue | Fix | Effort |
|---|-------|-----|--------|
| 3 | Wallet private key storage unspecified | Define wallet.json encryption at rest (same standard as identity key). Document co-location risk. Add recommendation for external wallet key storage for high-balance agents | Low |
| 4 | MCP tool description injection from API responses | Clarify that MCP tool descriptions are static strings, not dynamically populated from MoltBridge API responses. Apply Section 3.14 sanitization rules to all API-sourced content that touches MCP tool metadata | Low |

### P2 — Before Phase 6 (HA Design)

| # | Issue | Fix | Effort |
|---|-------|-----|--------|
| 5 | Redeemed-tokens set persistence undefined | Specify that redeemed-tokens set is persisted synchronously to disk. Define state file location | Low |
| 6 | JWT audience claim verification not explicit | Add to Section 3.9: recipient MUST verify aud claim matches own fingerprint | Low |
| 7 | Relay HA design gaps for security-relevant state | Specify PoW epoch synchronization, redeemed-tokens replication, and FTS5 directory replication in HA design | Medium |

---

## Scalability Assessment (Security Lens)

The security architecture scales well to Phase 0-3 (local + relay, <500 agents). Phase 4 (MoltBridge integration) introduces a new attack surface via the MoltBridge API, USDC wallet, and MCP tool exposure — all manageable with the fixes above. Phase 5+ (production bridge) is where the attack surface becomes broad: Neo4j super-node traversal timing attacks remain possible even with the pre-computed score mitigation (batch lag creates a window), and at 5000+ agents, the retaliation pattern detection in MoltBridge's graph analysis may generate false positive spikes.

The 10x PoW ceiling and fast-solver throttling are well-designed. The per-target receive rate limiting (20 messages/hour from untrusted) and per-sender offline queue limits (10 messages per sender) are correct implementations of the P1 scalability recommendations from Round 4.

---

## Summary

v0.4.0 is a substantially improved specification. All 6 Round 4 P0 security items are resolved — specifically:

1. **HKDF-SHA256 KDF specification** — Now fully specified in Section 3.3.1 with correct parameters, transcript hash binding, test vector requirements, and Noise pattern alternative. This was the highest-risk crypto gap. It is closed.

2. **Trusted-channel prompt injection** — Section 3.14 is a well-reasoned defense with explicit role-separation framing, policy enforcement as blast-radius limiter, and Phase 6 behavioral monitoring. It correctly acknowledges no mitigation is 100% effective.

3. **Recovery fraud protection** — Section 3.10 specifies 24-hour time-lock, cancellation window, multi-channel notification, human confirmation, rate limiting (3 attempts/24h). This is a complete and correctly designed fraud prevention system.

4. **Migration deadline** — 30-day hard deadline with enforcement mechanism (legacy fingerprints rejected after deadline, peer warnings) and rationale (prevents identity confusion attack window).

The remaining issues are narrower: a documentation gap around HKDF salt per-session uniqueness, an underspecified private key encryption-at-rest scheme, and a wallet.json encryption gap. None of these are design flaws — they are specification completeness issues that could lead to insecure implementations if left vague.

The security architecture is now in a state where Phase 0-3 implementation can begin with confidence, provided the two P0 documentation gaps (HKDF salt freshness and identity private key encryption scheme) are closed before implementation starts.

---

*Security review, Round 5. 2026-03-29. Reviewer: Security Specialist.*

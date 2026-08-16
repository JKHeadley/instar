# Architecture Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-171842
**Date**: 2026-03-29
**Round**: 5
**Reviewer**: Systems Architecture
**Spec**: unified-threadline-moltbridge-instar.md (v0.4.0)
**Prior Synthesis**: Round 4 (8.0/10, 8 specialized reviewers)

---

## Approval Status

**CONDITIONAL APPROVE** — Score: **9.2 / 10**

v0.4.0 is a high-quality architecture document. All eight P0 items from Round 4 are addressed, and the majority of P1 items are resolved. The spec has matured from a raw architectural sketch into a production-ready blueprint. The remaining issues are targeted and addressable without restructuring.

---

## Research Findings

### HKDF-SHA256 with X25519 (Trail of Bits, RFC 9709, 2025)

The spec's KDF specification in Section 3.3.1 is **correct and well-founded**. Trail of Bits' January 2025 key derivation guidance confirms: raw X25519 output is a group element with biased bits and must not be used directly as a symmetric key. HKDF extraction is the correct step. RFC 9709 (January 2025) standardizes HKDF-SHA256 for exactly this use case. The transcript-bound salt (SHA-256 of ephemeral public keys and nonces) is the right approach — it binds the derived key to the specific handshake and prevents cross-session key reuse. The spec's formulation is technically sound.

**One nuance**: RFC 9709 and current Trail of Bits guidance recommend the salt be unpredictable when possible. The spec's transcript hash is deterministic from public handshake data — this is acceptable (and is what Noise XX/IK does internally), but implementors should understand this is a domain-separation function, not a randomness extractor. The security argument holds: domain separation + HKDF extraction from the DH output is sufficient.

**Noise alternative**: The spec correctly identifies Noise_XX and Noise_IK as valid alternatives. Noise uses HKDF internally with its chaining key as salt and zero-length info. The spec's requirement to include "threadline" in the info string when using Noise is appropriate for domain separation. Noise_IK is preferable for the common case (mutual knowledge) due to 0-RTT properties; Noise_XX is more appropriate for introduction flows.

### Ed25519 → X25519 Conversion

**Critical finding**: The spec implicitly relies on Ed25519-to-X25519 conversion (single keypair, used for both signing and ECDH). Research confirms this conversion is mathematically possible via the Curve25519 birational equivalence, and Libsodium provides `crypto_sign_ed25519_pk_to_curve25519()` for this purpose. However, the cryptographic security research (IACR ePrint 2021/509, "On using the same key pair for Ed25519 and an X25519-based KEM") identifies specific risks:

- The security of combined use depends on which operation is performed first
- Cross-protocol attacks are possible if the same key is used without domain separation
- OpenSSL developers explicitly declined to support this conversion, calling it "not a good idea" for general use

**The spec does not explicitly address this conversion.** Section 3.3 states "Ed25519 identity + X25519 ephemeral encryption" but doesn't specify whether X25519 keys are derived from the Ed25519 key or generated independently. This is a **gap** — see Critical Issues.

### BIP-39 + Argon2id for Recovery

BIP-39's standard derivation uses PBKDF2-HMAC-SHA512 with 2048 iterations. The spec replaces this with Argon2id — a stronger choice for the recovery use case (memory-hardening against GPU/ASIC attacks). The parameters specified (`t=3, m=65536, p=4`) are reasonable: the OWASP password storage cheat sheet recommends `m=19456` minimum; the spec exceeds this. The fixed salt `"instar-recovery-v1"` is standard practice for deterministic derivation (where randomness would defeat the recovery purpose). This is sound. The spec also correctly generates the recovery keypair independently of the primary Ed25519 keypair (CSPRNG), which addresses the key-separation concern above for the recovery path.

### @noble/ed25519 and @noble/curves Library Status

- `@noble/ed25519` v1 was audited by cure53 in February 2022. The current v2 is a rewrite that has not been independently audited, though it cross-tests against noble-curves.
- `@noble/curves` has received targeted audits (sr25519/Polkadot cryptography, June 2025), but the core Ed25519 and X25519 implementations may not have a recent full audit.
- Both libraries are maintained by Paul Miller, widely considered trustworthy in the JS crypto community, with constant-time operation caveats noted (JIT/GC make absolute guarantees hard in JS).
- **For a security-critical production deployment, the spec should recommend pinning to audited versions and evaluating whether libsodium bindings (via sodium-native or tweetnacl) would provide a more audited baseline for the identity operations.**

### Prompt Injection Research (OWASP LLM01:2025)

OWASP confirms that "LLMs cannot currently distinguish between trusted instructions and untrusted content." The spec's role-separation framing approach (Section 3.14) is aligned with OWASP's recommended mitigation: explicit boundary markers between system instructions and untrusted input. The defense-in-depth layering (framing → policy enforcement → monitoring) is architecturally correct. The key insight the spec correctly captures: policy enforcement being deterministic means injection cannot escalate privileges even if it manipulates LLM reasoning — this is the right threat model decomposition.

---

## Round 4 P0 Resolution Assessment

| P0 Item | Round 4 Requirement | v0.4.0 Status | Assessment |
|---------|---------------------|---------------|------------|
| 1. KDF specification | Specify HKDF-SHA256 between X25519 and XChaCha20 | Section 3.3.1 — full spec with transcript hash, domain separation, test vector requirements, Noise alternative | **RESOLVED** — Technically sound and complete |
| 2. Rename MoltBridge | Remove "Molt" prefix before launch | Section 7.1 — acknowledged, alternatives proposed, action items listed | **RESOLVED** (acknowledged) — Name decision pending, which is appropriate pre-launch |
| 3. Recovery fraud protection | Time-lock + audit + human confirmation | Section 3.10 — 24h time-lock, cancellation window, notification, audit log, rate limiting (3/24h) | **RESOLVED** — Comprehensive |
| 4. Migration hard deadline | 30-day deadline for dual-key mode | Section 3.10 — 30-day deadline with explicit rationale, peer warning triggers | **RESOLVED** |
| 5. Error contracts | Error schema + per-endpoint codes | Section 3.8 — structured error schema, per-endpoint error code tables, retryable field, requestId | **RESOLVED** |
| 6. Capability tag vocabulary | Controlled vocabulary for attestations | Section 3.13.1 — 8-category vocabulary with proposal flow | **RESOLVED** |
| 7. Business model | Define revenue structure | Section 7 — discovery fees, broker share, premium tiers, founding terms | **RESOLVED** (placeholder status acknowledged, appropriate for spec stage) |
| 8. Prompt injection threat model | Trusted-channel injection defense | Section 3.14 — role-separation framing, system prompt instruction, capability description sanitization, defense-in-depth layers | **RESOLVED** — Architecturally sound |

All 8 Round 4 P0 items are addressed. This is a genuine improvement, not cosmetic.

---

## Critical Issues

### C1 — Ed25519 / X25519 Key Relationship Unspecified (Medium Severity)

**Severity**: Medium (implementation risk, not spec design flaw)

The spec specifies "Ed25519 identity + X25519 ephemeral encryption" but does not explicitly state how X25519 keys relate to the Ed25519 identity key. Two approaches exist:

1. **Independent X25519 ephemeral keys** (generated fresh per-session from CSPRNG) — no key reuse concern, standard Diffie-Hellman ephemeral practice
2. **X25519 static key derived from Ed25519 key** — requires birational conversion, carries documented risks (IACR 2021/509)

If the design intent is ephemeral-only X25519 (new keypair per handshake), this is cryptographically clean and should be stated explicitly. If any static X25519 keys are derived from the Ed25519 identity key, the spec must reference the security analysis and constraints.

**Recommendation**: Add one sentence to Section 3.3.1 clarifying: "X25519 keys are generated as fresh ephemeral keypairs per handshake. The Ed25519 identity key is NOT converted to or used as an X25519 static key. The identity key is used only for Ed25519 signing operations."

**Effort**: Low (one paragraph addition). **Phase gate**: Phase 0.

---

### C2 — @noble Library Version Pinning and Audit Coverage Gap (Low Severity)

**Severity**: Low (operational risk)

The spec recommends `@noble/ed25519` and `@noble/curves` without version pinning or audit qualification. The v2 rewrite of noble-ed25519 has not received a fresh independent audit. For an identity system handling signing keys and HKDF derivation, this matters.

**Recommendation**: Specify minimum version pins in Section 3.3.1 and note the audit status. Either pin to the last cure53-audited v1 (accepting limited API) or document that v2's cross-testing against noble-curves is the accepted risk mitigation. Alternatively, consider `sodium-native` (Node.js libsodium binding) for identity operations where audit trail matters most.

**Effort**: Low. **Phase gate**: Phase 0 (before key lifecycle implementation).

---

## Recommendations

### R1 — Clarify Noise Pattern Selection Guidance

Section 3.3.1 permits either explicit HKDF or Noise_XX/Noise_IK. Noise_IK requires the initiator to know the responder's static public key in advance (mutual knowledge). Noise_XX does not. For introduction flows (first contact via MoltBridge discovery), Noise_XX is required. For reconnections to known contacts, Noise_IK is preferable (0-RTT, better forward secrecy for the static key).

**Add guidance**: "Use Noise_IK for reconnections to known contacts. Use Noise_XX for introduction flows (first contact with unknown agents). Do not mix patterns in the same implementation without distinguishing the connection type."

**Effort**: Low.

### R2 — Argon2id Parameter Rationale Should Cite Target Hardware

The recovery derivation parameters (`t=3, m=65536, p=4`) are reasonable but the spec doesn't state what derivation latency to expect on target hardware. An attacker with a GPU will find these parameters adequate; a user on a slow device may find them too slow.

**Add**: "Target derivation time: 500ms–2s on commodity hardware (2024-era mid-range laptop). Measure on Raspberry Pi 4B as lower bound. Parameters may be adjusted upward in future versions; version-tag the parameters in the recovery phrase encoding."

**Effort**: Low (spec addition only).

### R3 — Wallet Key Separation from Identity Key (P2 carried from Round 4)

Section 3.8 lists `wallet.json` alongside `registration.json` and `attestations.json`. Round 4 (Security) flagged wallet private key co-location with identity key. The spec's wallet is non-custodial (Base L2 address), but if the wallet keypair is stored in the same directory and backup process as the identity keypair, a single compromise vector affects both.

**Recommendation**: Specify that wallet.json stores only the wallet address (public) and funding status. Private key for on-chain transactions should use a separate key generation path with its own backup flow, explicitly documented as distinct from identity recovery. The USDC wallet is a separate concern from identity.

**Effort**: Low (spec clarification).

### R4 — Migration Status Privacy Enhancement

Section 3.10 correctly restricts `migrationStatus` to authenticated channels, not `.well-known/agent.json`. However, the spec doesn't address what happens if a well-meaning peer inadvertently reveals migration status (e.g., by including it in a capability description or attestation).

**Recommendation**: Add: "Peers who learn an agent's migration status via authenticated channel MUST NOT include it in public-facing records (attestations, directory listings, Agent Cards). Migration status is treated as sensitive metadata."

**Effort**: Low.

### R5 — Recovery Phrase Version Tagging

The spec specifies BIP-39 + Argon2id for recovery key derivation. Future spec versions may change parameters. The recovery phrase has no version indicator — an agent attempting recovery 3 years later may not know which parameters to use.

**Recommendation**: Encode a version byte or structured prefix in the recovery phrase format (or in the `recoveryCommitment` stored in `identity.json`). This is common practice in wallet recovery systems.

**Effort**: Low.

---

## Observations

### Architectural Strengths (v0.4.0)

1. **Three-layer trust model is clean and well-specified.** The Identity/Trust/Authorization separation solves the core conflation problem identified in Round 1. The policy evaluation algorithm (deny-overrides-allow, default-deny) is standard and correct.

2. **Section 3.3.1 (KDF) is the best new section.** The explanation of why raw X25519 is insufficient, the explicit test vector requirements, and the Noise alternative guidance make this implementation-ready. The transcript hash binds the key to the handshake in a way that prevents cross-session reuse.

3. **Section 3.14 (prompt injection) demonstrates sophisticated threat modeling.** The recognition that deterministic policy enforcement limits blast radius even when injection succeeds is the correct architectural response. Many specs in this space treat prompt injection as a binary problem; this spec correctly treats it as a residual risk to manage with layers.

4. **Attestation retaliation suppression (Section 3.13.1) is genuinely novel.** Blinded attestations with k-anonymity, combined with anomaly detection for "suspiciously positive" patterns and Louvain community detection for collusion clusters, goes beyond what most trust systems specify.

5. **Waterfall discovery with explicit degraded modes is production-grade.** The local → relay → network fallback with defined timeout budgets, cache invalidation rules, and duplicate resolution precedence is the kind of detail that prevents production surprises.

6. **Security invariants (Section 4.3) are well-chosen.** "No policy enforcement by LLM" and "local override" are the two most important invariants in the whole design. Having them explicitly enumerated makes implementation auditing tractable.

7. **Phase sequencing is sensible.** Threat model and key lifecycle before any code (Phase 0), identity unification before trust model (Phase 1→2), closed default before MoltBridge integration (Phase 3→4). The dependency ordering is correct.

### Remaining Gaps (Not Blockers)

1. **Testing strategy is underspecified.** Phase 6 mentions an integration test suite but no unit test approach for the three-layer trust model. The authorization policy evaluation algorithm deserves property-based testing (fuzz the deny-overrides-allow logic). Mentioned in Round 4 synthesis as a gap; still unaddressed.

2. **Clock skew handling is present but incomplete.** Section 4.3 adds ±30s tolerance for TTL checks and recommends drift detection at >15s. But invitation tokens have 24h TTL — 30s tolerance is negligible there. The concern is grant expiry (4h TTL), where 30s tolerance matters. Consider whether the tolerance should be TTL-proportional or fixed. This is an edge case but worth one paragraph.

3. **Authorization schema migration is specified for v1→v2 (reject unknown versions) but the upgrade path is not.** How does an agent communicate that it now supports schema v2? How does a v1 peer interoperate with a v2 grant? The spec says "reject unknown versions" but doesn't define the version negotiation handshake.

4. **MoltBridge rate limit on `POST /moltbridge/attest` is listed as P2 (nice to fix).** Given that the attestation system is central to trust scoring, an undefended write path is a long-term risk. The controlled vocabulary already provides one layer; rate limiting should be a Phase 4 or 5 item, not P2.

5. **Operational runbook absent.** No incident response, rollback procedures, or on-call guidance. This matters more for MoltBridge (centralized Neo4j service) than for the local-first components. Still unaddressed from Round 4 synthesis.

---

## API Design Assessment

The MoltBridge proxy endpoint design (Section 3.8) is solid:

- Consistent error structure with `code`, `message`, `details`, `retryable`, `documentation`, `requestId`
- Per-endpoint error code tables provide implementation contracts
- `retryable + retryAfter` pattern follows standard REST retry semantics

**One gap**: The spec doesn't define the HTTP status code mapping from error codes. `RATE_LIMITED` should be 429. `SERVICE_UNAVAILABLE` should be 503. `INSUFFICIENT_BALANCE` should be 402 or 422. Without explicit HTTP status codes alongside the error code table, clients can't distinguish error categories from the HTTP layer alone.

**Recommendation**: Add a "HTTP Status Codes" column to the error contract table in Section 3.8.

---

## Data Architecture Assessment

**Neo4j trust graph**: The super-node mitigation (pre-computed centrality scores at >500 relationships, materialized trust scores) is specified. This is the right approach. Louvain community detection for collusion clusters adds write load but is a batch operation — appropriate.

**FTS5 relay directory**: SQLite FTS5 is adequate for the scale targeted (MVP through ~2000 agents). No concerns at this scale.

**Local trust store**: The spec doesn't define the storage format for local trust state. Is it SQLite? JSON files? Append-only log? For tamper resistance (audit log hash chain) and concurrent access (multiple sessions), the storage choice matters. The spec mentions "append-only log with hash chain" for the audit log but doesn't specify the underlying format.

**IQS cache TTL (1h)**: Appropriate for the advisory nature of the signal. Cache invalidation on trust-level change is correct.

---

## Integration Points Assessment

**MoltBridge circuit breaker** (3 failures → 5 min disable): Standard circuit breaker pattern. The spec correctly applies it to the enrichment pipeline. Consider whether the 5-minute window is long enough (a brief network interruption would repeatedly trigger it) and whether exponential backoff is preferable to a fixed window.

**Wallet integration**: Non-custodial Base L2 wallet with QR code funding is architecturally clean — Instar holds no custody. The "denial of wallet" economic DoS attack is addressed with per-peer caps and daily spend limits. This is thorough.

**A2A interoperability**: The shared Agent Card with dual-fingerprint support during migration is elegant. The precedence rule (local signed contact > active relay proof > MoltBridge cached > stale directory) is well-defined.

---

## Complexity Budget Assessment

The spec's complexity is justified. Three cooperating systems (Instar + Threadline + MoltBridge) serving genuinely distinct concerns (runtime + messaging + trust). The integration complexity is contained by:

- Clear ownership boundaries (each system manages its own data)
- Async enrichment with circuit breaker (prevents tight coupling)
- Local-first design (MoltBridge failure is graceful degradation, not outage)

**Accidental complexity risks**:
- Dual-key transition mode is complex but time-bounded (30-day hard deadline mitigates this)
- The discovery waterfall with 3 layers and timeout budgets requires careful implementation; test coverage of degraded paths is critical
- Authorization policy evaluation with wildcard matching and deny-overrides-allow needs property-based testing to verify correctness

Overall: complexity budget is justified and mostly contained.

---

## Scalability Assessment

| Phase | Assessment | Key Constraints | Change from Round 4 |
|-------|-----------|-----------------|---------------------|
| MVP (10-50 agents) | LOW risk | None significant | Unchanged |
| Growth (50-500 agents) | LOW-MEDIUM risk | Relay connections, attestation write volume | Improved (P1 items addressed) |
| Scale (500-5000 agents) | MEDIUM risk | Super-node mitigation now specified; relay HA design in Phase 6 | Improved (previously HIGH) |
| Viral spike (5000+) | HIGH risk | Relay HA not yet implemented (Phase 7), business model still placeholder | Unchanged |

The Neo4j super-node problem has a specified mitigation. The relay SPOF has a design (multi-region + Redis Pub/Sub) but not yet an implementation phase. PoW difficulty ceiling is now capped at 10x baseline. These collectively reduce the 500-5000 agent risk from HIGH to MEDIUM.

---

## Evolution Path Assessment

The spec is well-designed for evolution:

- Authorization policy schema is versioned (v1, extensible)
- Recovery phrase derivation is parameterized (Argon2id parameters can be upgraded)
- Noise protocol alternative allows crypto agility without API changes
- Standalone threadline-mcp is explicitly preserved as a non-Instar path
- Migration semantics are defined (dual-key with hard deadline)

**One evolution risk**: The controlled vocabulary for attestation capability tags grows via proposal → 3-use threshold → inclusion. This is a governance mechanism, not purely technical. If MoltBridge governance is unclear (who controls the vocabulary?), tag proliferation or stagnation becomes a long-term risk.

---

## Score: 9.2 / 10

**Scoring breakdown:**

| Dimension | Score | Notes |
|-----------|-------|-------|
| Technology Choices | 9.5 | Noble crypto stack is reasonable; audit gap noted; Noise alternative well-specified |
| System Design | 9.5 | Three-layer separation is clean; ownership boundaries clear; local-first is a genuine strength |
| API Design | 8.5 | Error contracts solid; missing HTTP status code mapping |
| Data Architecture | 8.5 | Storage format for local trust state underspecified; Neo4j mitigation added |
| Integration Points | 9.0 | Circuit breaker, fallback modes, duplicate resolution all well-specified |
| Operational Concerns | 7.5 | Metrics endpoint added; audit log specified; operational runbook still absent |
| Complexity Budget | 9.0 | Justified complexity; accidental complexity risks identified and managed |
| Evolution Path | 9.5 | Versioned schema, parameterized crypto, clear migration semantics |

---

## Summary

v0.4.0 resolves all Round 4 P0 items. The new Section 3.3.1 (KDF) is the most technically significant addition — it closes a real cryptographic gap with appropriate rigor. Section 3.14 (prompt injection) and Section 3.13.1 (attestation retaliation) add meaningful coverage for issues that most agent specs ignore entirely.

The two remaining critical issues are implementation clarifications, not design flaws: the Ed25519/X25519 key relationship needs one explicit sentence, and the noble library version pinning needs documentation. Both are Phase 0 items — addressable before key lifecycle code is written.

The business/naming sections (7, 7.1) remain placeholders, which is appropriate for a technical spec — those decisions require human judgment and market input, not architectural specification. The spec correctly flags them and defers.

The architecture is ready for Phase 0 implementation with the two clarifications noted above.

---

*Architecture review, Round 5. Spec v0.4.0. 2026-03-29.*

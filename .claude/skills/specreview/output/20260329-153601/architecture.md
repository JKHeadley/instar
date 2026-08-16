# Architecture Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-153601
**Reviewer**: Technical Architecture
**Round**: 4
**Date**: 2026-03-29

---

### Approval Status: CONDITIONAL APPROVE

### Score: 9.4/10

**Justification**: The spec has reached architectural maturity. The three-layer trust model (identity → trust → authorization) is correctly constructed, cryptographic choices are sound, and the threat model is comprehensive. All P0/P1 issues from Rounds 2 and 3 are resolved. Three remaining P1 items should be addressed before Phase 0 code freeze but do not block approval.

---

### Critical Issues (must fix before building)

None remaining from prior rounds. All P0 items resolved.

---

### P1 Issues (should fix before Phase 0 code freeze)

1. **Recovery key generation underspecified** (Section 3.10)
   - `identity.json` holds a `recoveryCommitment` but doesn't say whether the recovery keypair is independently CSPRNG-generated or derived from primary key material (e.g., via a mnemonic/BIP39 seed).
   - If the recovery key is derived from the primary key, compromise of the primary key material compromises recovery too — single point of failure.
   - **Fix**: Add one explicit sentence: "The recovery keypair is independently CSPRNG-generated and stored separately from the primary keypair. The recovery phrase is a BIP39 mnemonic that encodes the recovery private key, not the primary key."

2. **Policy schema has no migration path** (Section 3.6)
   - `schemaVersion: 1` is declared extensible but v1→v2 behavior is unspecified. When a peer presents a v2 policy to a v1 agent, does the agent reject it? Accept with best-effort? Silently ignore new fields?
   - **Fix**: Define backward-compatibility rule: "Agents MUST accept policies with schemaVersion ≤ their supported version. Unknown fields in constraints are ignored (open-world assumption). Policies with schemaVersion > supported version are rejected with a clear error indicating the required version."

3. **Relay HA is out of all phase scopes** (Section 6 / Non-Goals)
   - The Fly.io single-instance relay is a production SPOF. Federation is mentioned in Open Question #6 but sits in "future work" rather than any phase deliverable.
   - For a system that positions itself as production-ready after Phase 6, a single relay instance is a significant availability risk.
   - **Fix**: Add relay HA (multi-region with Redis Pub/Sub backplane) as a Phase 6 deliverable, even if federation remains out of scope.

---

### Recommendations (should fix, not blocking)

1. **Canonical encoding appendix**: The spec references Ed25519 signatures, CSPRNG tokens, and hash computations but doesn't specify canonical byte encodings for signed payloads. For interoperability (especially with non-TypeScript implementations), define canonical serialization (e.g., JCS for JSON canonicalization, or explicit field ordering).

2. **Agent Card versioning**: The shared Agent Card at `/.well-known/agent.json` should include a schema version field. A2A v1.0.0-rc is still evolving, and the card needs to signal which protocol version it supports.

3. **Circuit breaker configuration**: Multiple circuit breakers are defined (MoltBridge enrichment, trust decay, relay reconnect) but with hardcoded thresholds. Consider a unified circuit breaker config section with tunable parameters.

4. **Idempotency for trust operations**: `POST /moltbridge/attest` and `POST /moltbridge/register` should specify idempotency behavior — what happens if called twice with the same data?

---

### Observations (nice to know)

- The separation of Threadline (messaging), MoltBridge (reputation), and Instar (runtime) is clean and maps well to the "Three-Layer Trust" model. Each system has a clear responsibility boundary.
- The decision to use Ed25519 for signing and X25519 for encryption (derived via Curve25519 conversion) is the standard modern approach. The spec's explicit prohibition on using signing keys as HKDF input material shows crypto awareness.
- The discovery waterfall (local → relay → network) with sequential execution and timeout budgets is pragmatic. The duplicate resolution by fingerprint with source precedence is well-specified.
- The dual-key migration mode for existing agents is well-designed — preserves backward compatibility while enabling the unified identity goal.
- A2A is at v1.0.0-rc under Linux Foundation, well-aligned with the shared Agent Card approach.

---

### Scalability Assessment

- **Phase 1 (MVP)**: Architecture is well-suited. Single-machine, local-first design means zero infrastructure complexity. Relay on Fly.io is fine for 10-50 agents.
- **Phase 2 (Growth, 10x)**: The 500-agent range will stress the relay's single-instance design. WebSocket connection limits (~10K per instance on Fly.io) are adequate, but message throughput may need monitoring. Neo4j graph queries remain fast at this scale.
- **Phase 3 (Scale, 100x)**: At 5,000+ agents, the relay needs multi-region deployment (Phase 6 deliverable as recommended above). MoltBridge graph traversal for broker discovery may need query optimization or caching. The 1-hour IQS cache TTL is appropriate.
- **Viral spike handling**: The PoW + identity aging + IP rate limiting provides reasonable protection. Dynamic PoW difficulty scaling under attack conditions is well-designed. The main risk is relay connection exhaustion — a backpressure mechanism (connection queue with priority for known agents) would help.

---

### Research Findings

1. **Ed25519 + X25519 dual-use**: The spec correctly separates signing (Ed25519) from encryption (X25519 ephemeral). The prohibition on using Ed25519 private keys as HKDF input is cryptographically important — RFC 8032 Ed25519 keys have a specific internal structure that makes them unsuitable as generic key derivation material.

2. **A2A Protocol Status**: Google's Agent-to-Agent protocol is at v1.0.0-rc under Linux Foundation governance. The shared Agent Card approach aligns well. The spec should track A2A evolution as it standardizes.

3. **WebSocket Relay Scaling**: Redis Pub/Sub backplane for multi-instance relay is the canonical production pattern (used by Socket.IO, Phoenix Channels, etc.). The spec names this correctly in the federation section.

4. **Three-Layer Trust Models**: The identity → trust → authorization decomposition matches Zero Trust Architecture (NIST SP 800-207) and emerging agentic identity frameworks. The spec's explicit separation of these concerns is architecturally correct and well-aligned with industry direction.

---

*Generated by SpecReview Architecture Reviewer, Round 4.*

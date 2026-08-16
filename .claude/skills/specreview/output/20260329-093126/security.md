# Security Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-093126
**Reviewer**: Security
**Date**: 2026-03-29
**Round**: 1

---

## Approval Status: CONDITIONAL (NOT APPROVED without fixes)

## Score: 6.2/10

**Justification**: The spec demonstrates strong cryptographic foundations (Ed25519/X25519, XChaCha20-Poly1305, HKDF) and correct high-level security principles (closed-by-default, no auto-escalation, local trust precedence). However, five critical vulnerabilities exist in the integration layer between Threadline and MoltBridge that could be exploited before Phase 6 hardening arrives.

---

## Research Findings

- **Ed25519/X25519**: No known cryptographic weaknesses. Implementation risks: clamping errors in X25519 (libsodium handles correctly, raw Node.js crypto may not), timing side-channels in non-constant-time implementations.
- **XChaCha20-Poly1305**: Correct choice for agent messaging — 192-bit nonce eliminates nonce collision risk even with random generation. No AES-NI dependency. Well-audited in libsodium.
- **HKDF-SHA256**: Standard, no known issues. The spec's use for relay token derivation is appropriate.
- **WebSocket security best practices**: Post-handshake frame authentication is a known gap in many WS implementations. Each frame should carry a session MAC or be part of an authenticated stream. The spec's relay protocol doesn't specify this.
- **JWT cross-service replay**: Well-documented attack class. Using JWTs across trust boundaries without `aud`/`iss` validation is a known antipattern (RFC 7519 Section 4.1.3).
- **Agent-to-agent prompt injection**: Active research area (2025-2026). MAS Hijacking (Multi-Agent System Hijacking) demonstrated that a single compromised agent can cascade prompt injection through an entire agent network via message content.

---

## Critical Issues

### CRIT-1: JWT Credibility Packet Handshake Shortcut (Section 3.9) — Replay/Forgery Surface

**Severity**: CRITICAL
**Section**: 3.9 (Threadline ↔ MoltBridge Bridge)

The spec proposes using a MoltBridge credibility packet (signed JWT) to "skip the full challenge-response for the first message" in Threadline. This JWT was issued by MoltBridge for MoltBridge consumers. Using it as a Threadline handshake credential without:
- `aud` claim validation (JWT doesn't say "for Threadline")
- `iss` verification against Threadline's trusted issuers
- Replay protection (JWT can be reused across multiple Threadline connections)

An attacker who intercepts a credibility packet (from any MoltBridge query result) can present it to any Threadline endpoint and impersonate the agent it describes.

**Fix**: Either (a) remove the handshake shortcut entirely — always require Ed25519 challenge-response, or (b) issue a purpose-bound token: MoltBridge signs a "Threadline introduction" JWT with `aud: "threadline"`, `exp: 5min`, and a nonce tied to the specific connection attempt.

### CRIT-2: Same-Machine Fast Path Overstates OS Isolation (Section 3.5)

**Severity**: HIGH
**Section**: 3.5 (Trust Bootstrapping)

The spec auto-grants `verified` trust to same-machine agents based on "filesystem permissions (Unix socket or shared file signed by both)" and "OS-level identity proof." This assumes:
- Process isolation is sufficient (it isn't if any local process is compromised)
- Filesystem ownership checks are race-condition-free (TOCTOU vulnerability)
- The AgentRegistry cannot be spoofed by a local attacker

A compromised local process (e.g., a malicious npm package) could register a fake agent in the AgentRegistry, create a Unix socket with the correct ownership, and receive `verified` trust without any cryptographic proof.

**Fix**: Same-machine fast path should still require a lightweight cryptographic challenge (e.g., sign a nonce with the claimed Ed25519 key). The fast path skips the relay and the full handshake ceremony, not the identity proof.

### CRIT-3: MoltBridge-Discovered Agents Auto-Granted `verified` (Section 3.5)

**Severity**: HIGH
**Section**: 3.5 (Trust Bootstrapping)

The spec states: "MoltBridge-discovered agents: Initial trust: `verified` (MoltBridge already did Proof-of-AI + cross-verification)." This directly contradicts the spec's own principle that "local trust always takes precedence" (Section 3.2).

If `api.moltbridge.ai` is compromised, or if MoltBridge's Proof-of-AI is bypassed, every agent discovered through MoltBridge inherits `verified` trust automatically. This turns MoltBridge into a single point of trust injection.

**Fix**: MoltBridge-discovered agents should start at `untrusted` with an advisory flag: "MoltBridge IQS: high (verified via Proof-of-AI)." The user/agent decides whether to upgrade to `verified`. The MoltBridge signal is context, not authorization.

### CRIT-4: Prompt Injection Protection Deferred to Phase 6 (Section 4)

**Severity**: HIGH
**Section**: 4 (Implementation Phases)

MAS Hijacking research (2025-2026) demonstrates that agent-to-agent message content can contain prompt injection payloads that cascade through multi-agent workflows. The spec ships messaging (Phase 1-3) and MoltBridge integration (Phase 4-5) before the threat model and injection protection (Phase 6).

This means injectable message content flows through the system for 3-5 phases before any protection exists. The standalone threadline-mcp already uses `[UNTRUSTED AGENT-PROVIDED ...]` framing, but the built-in Threadline and MoltBridge integration points don't specify this.

**Fix**: Move prompt injection mitigation to Phase 2 (alongside trust model refactor). At minimum: (a) all agent-provided content must be wrapped in untrusted content markers, (b) trust level determines whether content is rendered directly or sandboxed, (c) capability scoping (Section 3.6) must gate task execution, not just message delivery.

### CRIT-5: No Post-Handshake WebSocket Frame Authentication

**Severity**: MEDIUM-HIGH
**Section**: 3 (Relay Protocol, implicit)

The relay protocol authenticates agents during the initial WebSocket handshake (challenge-response with Ed25519 signature). After that, individual frames are not authenticated. If a WebSocket connection is hijacked (e.g., via a compromised proxy or load balancer), an attacker can inject frames as the authenticated agent.

The message envelope includes an Ed25519 signature, which protects message integrity. But control frames (heartbeat, discover, presence subscribe) are not signed and could be spoofed within a hijacked connection.

**Fix**: Either (a) sign all control frames with the session key, or (b) derive a session MAC from the handshake and include it in every frame (lighter weight). The message envelope signatures already handle data integrity — this is about control plane integrity.

---

## Recommendations

| Priority | Recommendation | Phase |
|----------|---------------|-------|
| P0 | Write threat model BEFORE Phase 2, not Phase 6 | Phase 1.5 |
| P0 | Remove auto-`verified` for MoltBridge-discovered agents — start at `untrusted` + advisory | Phase 4 |
| P0 | Remove or harden credibility packet handshake shortcut | Phase 5 |
| P0 | Add prompt injection content framing to ALL agent message surfaces | Phase 2 |
| P1 | Same-machine fast path must still require Ed25519 nonce signing | Phase 2 |
| P1 | Sign or MAC all WebSocket control frames | Phase 3 |
| P1 | Add `aud`/`iss`/`purpose` claims to all cross-service JWTs | Phase 5 |
| P2 | Define key rotation ceremony (cross-system coordination) | Phase 3 |
| P2 | Rate limit invitation token generation (prevent token spray) | Phase 3 |
| P2 | Add session binding to relay tokens (prevent token migration between connections) | Phase 3 |

---

## Observations

**Security-positive design choices:**
- Closed-by-default posture is correct and rare in this space
- No auto-escalation of trust — addresses the most common reputation system attack
- Short-lived authorization grants (4h) limit blast radius of compromised grants
- Circuit breaker auto-downgrade provides defense-in-depth
- Local trust precedence prevents network-level trust injection (when correctly implemented)
- XChaCha20-Poly1305 with ephemeral keys provides forward secrecy

**Concerns to monitor:**
- The founding agent economic incentive creates pressure to weaken security for adoption speed
- USDC wallet addresses on Base L2 are permanently public — cross-correlation with agent identity is a deanonymization risk
- The relay's offline queue stores encrypted messages for offline agents — queue access control and TTL enforcement are critical

---

## Scalability Assessment (Security Dimension)

| Scale | Security Posture | Key Risk |
|-------|-----------------|----------|
| Small (10-50 agents) | Manageable | Limited attack surface, but fewer eyes on security |
| Medium (100-1000) | Strained | Relay becomes high-value target; trust graph attacks become viable |
| Large (1000+) | Requires dedicated security | Sybil attacks at scale; prompt injection cascades; relay DDoS |

---

*Generated by SpecReview Security Reviewer.*

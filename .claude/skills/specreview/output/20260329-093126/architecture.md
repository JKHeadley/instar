# Architecture Review: Unified Threadline × MoltBridge × Instar

**Review ID**: 20260329-093126
**Reviewer**: Technical Architecture
**Date**: 2026-03-29
**Round**: 1

---

## Approval Status: CONDITIONAL

## Score: 7.4/10

**Justification**: Architecture direction is correct. Phases 1–3 can proceed. Four critical issues should be resolved before Phase 4 (MoltBridge integration). None require architectural rethinking — they're specification gaps, not design errors.

---

## Research Findings

- **Multi-layer trust (2025-2026 consensus)**: The Cloud Security Alliance's 2026 Agentic AI IAM framework independently validates the spec's three-layer model. JWT delegation chains for multi-hop workflows are an emerging gap the spec doesn't yet address.
- **A2A Protocol**: Google's A2A 0.3+ adds signed Agent Cards and gRPC — the spec's "Shared Agent Card" approach is correct, but should be designed against the 0.3 spec to avoid future friction.
- **Shared Ed25519 keypair**: Technically sound (analogous to SSH fingerprints across systems). Primary risk is key rotation — once shared, rotating requires coordinated updates across Threadline relay contacts, MoltBridge registration, and all cached trust states. Undefined in the spec.
- **JWT credibility packet reuse**: Cross-service relay attacks on JWTs are a documented attack class. Using a MoltBridge-issued JWT as a Threadline handshake credential without `aud`/`iss` validation creates a cross-realm replay surface.

---

## Critical Issues

### C1: Single Relay = Single Point of Failure (HIGH)

The relay is single-instance on Fly.io. All cross-machine communication routes through it. Multi-instance relay with shared session state (Redis or NATS — Fly.io's own blog documents NATS for this) should be Phase 2 or 3 work, not deferred to the "federation story."

**Fix**: Define relay multi-instance architecture. NATS is a natural fit for Fly.io. Add this as Phase 3.5 or a Phase 4 prerequisite.

### C2: Credibility Packet as Handshake Shortcut — Security Gap (HIGH)

Section 3.9 proposes using a MoltBridge JWT to skip the Threadline challenge-response. The JWT was issued for MoltBridge consumption, not Threadline. Without explicit `aud` claim validation, this is a cross-service relay attack surface. A stolen credibility packet could bootstrap a false Threadline identity.

**Fix**: Use credibility packet to pre-populate trust context, but always require the Ed25519 challenge-response for identity verification. Add `aud`/`iss`/`purpose` claims to credibility packet spec.

### C3: Neo4j External Dependency, No Fallback Specified (MEDIUM-HIGH)

Trust enrichment calls to `api.moltbridge.ai` happen inline when adding a Threadline contact. No circuit breaker semantics defined. If MoltBridge is unreachable, does it fail silently, block, or timeout?

**Fix**: 3-second timeout, fail-open (proceed as `untrusted`), retry queue for failed enrichments.

### C4: Key Rotation Protocol Undefined (MEDIUM)

Shared identity makes key rotation a cross-system coordination problem. Neither the initial migration nor ongoing key lifecycle is specified.

**Fix**: Define key rotation ceremony: generate new pair → register new key with MoltBridge → update Threadline relay → grace period (accept both keys for 48h) → revoke old key.

---

## Recommendations

| Priority | Recommendation |
|----------|---------------|
| P0 | Specify bridge layer contracts (Section 3.9) before Phase 5: exact API calls, failure semantics, attestation trigger conditions, Agent Card versioning |
| P0 | Resolve Open Question 3 (identity linking) before Phase 4 — this is a prerequisite, not a post-launch item |
| P1 | Define trust score weighting explicitly: local `trusted`+ = MoltBridge advisory only; local `verified` + MoltBridge "low" = warning; local `untrusted` + MoltBridge "critical" = denylist candidate surfaced to user. No automatic downgrades |
| P1 | Keep payments out of Instar — surface balance/earnings read-only via `/moltbridge/status`. All deposit/withdrawal flows redirect to MoltBridge dashboard |
| P2 | Add `aud`/`iss` validation requirements and a `purpose` claim to credibility packet spec |
| P2 | Move threat model to Phase 1.5 (before Phase 2 trust refactor), not Phase 6 |
| P3 | `autoRegister: false` should be hardcoded default with onboarding prompt, not a silently configurable option |

---

## Observations (Strengths)

- Waterfall discovery is the right pattern; cost/trust/speed tradeoffs are explicit
- Non-goals section is excellent and scope-protective
- Phasing is credible — can't safely integrate MoltBridge until local trust model is correct
- "Trusted vs Autonomous" separation correctly implements the review finding
- 90-day trust decay and circuit breaker give the system self-healing behavior
- Local-first design eliminates network dependency for common operations

---

## Scalability Assessment

The relay is the binding constraint. Everything else (local SQLite, Neo4j graph, cached scores) scales reasonably. The local-first design is the correct mitigation. The relay needs multi-instance before any production agent network grows beyond a handful of machines.

| Phase | Architecture Assessment |
|-------|----------------------|
| Phase 1 (MVP) | Clean, no concerns |
| Phase 2-3 (Growth) | Sound if relay SPOF is addressed |
| Phase 4+ (Scale) | Requires relay federation + Neo4j tier upgrade + circuit breakers for external deps |

---

*Generated by SpecReview Architecture Reviewer.*

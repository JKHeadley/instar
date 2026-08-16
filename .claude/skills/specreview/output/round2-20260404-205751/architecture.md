# Architecture Review — Rich Agent Profiles for MoltBridge
## Round 2 | Reviewer: Systems Architecture | Date: 2026-04-04

**Spec Version**: v2 (post Round 1 synthesis 20260404-203628)
**Prior Status**: BLOCKED (avg 4.8/10, 7 critical blockers, 2 open conflicts)

---

## Approval Status

**CONDITIONAL APPROVE**

The v2 spec is a substantial improvement. All 7 Round 1 critical blockers have been addressed with real design work, not token gestures. The schema exists. The principal/agent identity confusion is resolved. The discovery tiering is sound. The API is clean. Two issues remain that need resolution before this is fully approvable, but neither is a blocker of the same severity as Round 1's deficiencies.

---

## Blocker Resolution Assessment (Round 1 → Round 2)

| Blocker | Round 1 Status | Round 2 Status | Assessment |
|---------|---------------|---------------|------------|
| 1. No profile authenticity verification | CRITICAL | Resolved | Ed25519 signing with canonical serialization, monotonic versioning, 5-min timestamp window — well-designed |
| 2. LLM synthesis reads attacker-controllable inputs | CRITICAL | Resolved | Hybrid pipeline: rule-based extraction → sanitized StructuredSignals → LLM narrative only. LLM never reads raw files. |
| 3. No defense against false profiles / Sybil | CRITICAL | Resolved | first_party vs attested separation is the right structural fix. Attestation ring detection added. |
| 4. USER.md/MEMORY.md PII exposure | CRITICAL | Resolved | Explicit allowlist table. USER.md banned. MEMORY.md only via #profile-safe tags. |
| 5. No consent mechanism | CRITICAL | Resolved | Human review gate mandatory before first publication. Auto-publish is opt-in with significance thresholds. |
| 6. Principal/Agent identity confusion | CRITICAL | Resolved | New AgentProfile type is distinct from PrincipalProfile. AgentNode retains identity; AgentProfile is the narrative layer. Clean separation. |
| 7. No profile schema | CRITICAL | Resolved | TypeScript interfaces defined: Specialization, TrackRecordEntry, RichProfilePayload. Character limits set. Neo4j graph model documented. |

All 7 blockers resolved. The 2 open conflicts from Round 1 (non-instar onboarding timing, privacy MVP scope) are also resolved — the phased migration path (Appendix B) addresses both.

---

## Schema Evaluation

The schema design is solid. Key decisions are correct:

**What's right:**
- AgentNode (immutable identity) separate from AgentProfile (mutable narrative) is the correct graph topology. These are fundamentally different lifecycle objects.
- ProfileVersion[] as a hash-chain audit trail is appropriate. previous_version_hash enables independent verification without full history traversal.
- Size limits are proportionate. 500 chars for narrative is enough for differentiation, tight enough to force clarity.
- source: "first_party" | "attested" on TrackRecordEntry is the right place to carry this signal — entry-level not profile-level.
- profile_completeness_score as a separate computed axis decoupled from IQS is well-executed.

**One concern — canonical serialization:**

The spec defines canonical serialization as:
  JSON.stringify(payload, Object.keys(payload).sort(), 0) + "|" + ISO8601_timestamp + "|" + version_number

Object.keys(payload).sort() only sorts top-level keys. Nested objects (specializations[].attested_by[], field_visibility) are NOT recursively sorted. Two semantically identical profiles with differently-ordered nested arrays would produce different signatures, breaking verification. This needs to be a deep canonical sort — or explicitly documented that consumers must re-sort before verifying.

**Recommendation**: Define a canonical serialization function explicitly (e.g., sort all object keys recursively, sort arrays of primitives, leave arrays of objects in declaration order). Reference an existing standard (JCS — JSON Canonicalization Scheme, RFC 8785) rather than implementing ad-hoc.

---

## API Design Evaluation

The /agent/profile/* API surface is clean and complete:

  POST   /agent/profile              — Create
  PUT    /agent/profile              — Update
  GET    /agent/profile/:id          — Full profile (Tier 2)
  GET    /agent/profile/:id/summary  — Discovery card (Tier 1)
  GET    /agent/profile/:id/deep     — Attestations + history (Tier 3)
  GET    /agent/profile/:id/history  — Version history
  DELETE /agent/profile              — GDPR erasure
  GET    /agent/profile/:id/verify   — Signature verification

**What's right:**
- Endpoints are namespaced under /agent/ (not /principal/) — cleanly resolves the Round 1 identity confusion.
- Tiered GET pattern (summary/full/deep) matches the progressive disclosure architecture.
- verify endpoint enables independent consumers to validate without trusting the registry.
- DELETE exists and the data lifecycle table specifies tombstone semantics + GDPR 30-day purge window.

**One concern — authentication surface not defined:**

The spec states Tier 2 and Tier 3 are "authenticated" but does not define what authentication means for external consumers. How does a non-instar agent prove it's a "registered" agent to access registered-visibility fields? Presumably it presents its MoltBridge agent_id + a signed challenge, but this is not specified.

This is not a blocker but will be the first implementation friction point. The auth model for the consumer side of the API needs at least a paragraph before implementation begins.

---

## Discovery Tiering Evaluation

The three-tier model is well-designed and correctly separates concerns:

- Tier 1 (<=1KB, cached 24hr at relays): Discovery cards carry the signature for end-to-end verification. Relay nodes cannot tamper without breaking the signature — this is a strong design choice.
- Tier 2 (authenticated, not cached at relays): Correct. Full profiles should not be relay-cached; they contain visibility-gated fields.
- Tier 3 (authenticated, live query, rate-limited): Correct. Attestation history and version diffs are heavy; on-demand only makes sense.

The Threadline integration (Tier 1 cards in discovery responses, Tier 2/3 fetched directly from MoltBridge) is architecturally sound. This prevents relay chains from becoming a privacy chokepoint.

**One gap**: The spec describes cache invalidation for Discovery Cards (24hr TTL, invalidated on profile update) but does not specify how relays receive invalidation signals. Pull (re-fetch at TTL expiry) or push (MoltBridge notifies known relay nodes on update)? At small scale this doesn't matter; at 1,000+ agents with active profiles, pull-only means stale cards in circulation for up to 24 hours. Worth a design note.

---

## Integration Points Evaluation

**A2A Compatibility (section 2.5)**: The /.well-known/agent-card.json endpoint with MoltBridge extensions in x-moltbridge namespace is the right approach. It plays well with existing A2A tooling while adding value. The "A2A = business card, MoltBridge = portfolio" framing is maintained architecturally.

**Threadline Integration (section 6.2)**: Clean. Profile signatures traveling with Discovery Cards is the right security primitive for a relay network.

**Instar Pipeline (section 3)**: The hybrid extraction pipeline (rule-based StructuredSignals -> LLM narrative) is well-specified. The source allowlist table (section 3.1) is the kind of explicit negative-space documentation that actually prevents data leaks. The 5K-token Haiku cost model is realistic.

**IQS Decoupling (section 8)**: Complete decoupling with a clear statement that IQS derives only from behavioral signals. profile_completeness_score as a parallel informational axis is correctly described. This is one of the cleaner solutions to a subtle trust inflation problem.

---

## Evolution Path Evaluation

The phased migration in Appendix B is coherent:

| Phase | Week | Assessment |
|-------|------|------------|
| Schema Extension + new API | 1 | Low-risk, backward-compatible. Correct first step. |
| Instar Compiler | 2 | Highest complexity. Extraction pipeline + human review gate. Right sequencing. |
| Seed Network | 3 | Validates the full loop with real data before opening externally. Smart. |
| Open Standard | 4+ | Non-instar onboarding after Sybil resistance is proven. Resolves Round 1 open conflict. |

The content-hash recompilation approach (section 3.4) is the right freshness mechanism — event-driven with a 24-hour debounce prevents thrash without going fully to scheduled batch. The jitter requirement is a thoughtful operational detail.

---

## Issues Remaining

### Issue 1 — Canonical Serialization Underspecified (Medium severity)
The JSON canonical serialization function must handle nested objects and arrays deterministically. As written, it only sorts top-level keys. Recommend referencing RFC 8785 (JCS) or writing out the exact normalization algorithm. This is load-bearing for cross-consumer signature verification.

### Issue 2 — Consumer Authentication Not Defined (Low-Medium severity)
The spec states Tier 2/3 endpoints require authentication but does not define the auth protocol for external consumers. An agent from another platform needs to know: what credential do I present, how do I prove my identity to access registered-visibility fields? One short section or a reference to an existing auth spec would close this gap.

---

## Residual Gaps (Carried from Round 1)

These gaps were identified in Round 1 but remain unaddressed in v2. They are not blocking for Phase 1-2 but will surface in Phase 3-4:

1. **Semantic search architecture**: Vector embeddings for capability matching are referenced but not designed. Needed before non-instar agents onboard at scale.
2. **Multi-hop profile integrity in Threadline**: How does signature verification work when a Discovery Card passes through multiple relay hops? Does each hop re-verify?
3. **Key rotation ceremony**: Section 9 describes the outcome (rotation notice signed by both keys) but not the ceremony — who initiates, what is the window before old key is revoked, how are cached cards handled?
4. **EU AI Act compliance**: Not assessed. Autonomous agent profiling systems may have obligations under the Act. Worth a legal review pass before public launch.

---

## Score

**8.0 / 10**

The spec went from 4.8 to 8.0 in one revision cycle. Every critical blocker from Round 1 was addressed with genuine design work. The schema is concrete and implementable. The security model is coherent. The privacy architecture is credible. The API is clean.

The 2.0-point gap is:
- 0.8 pts: Canonical serialization underspecified (implementation will diverge across consumers)
- 0.5 pts: Consumer authentication not defined (first friction point in implementation)
- 0.5 pts: Residual gaps (semantic search, key rotation ceremony, relay verification) that are below the line for MVP but are known holes
- 0.2 pts: Cache invalidation mechanism for relay nodes not specified

This spec is ready to drive Phase 1 (schema extension + API) and Phase 2 (instar compiler) implementation. The two remaining issues can be resolved inline during Phase 1 without blocking start.

---

## Recommendation

**Proceed to implementation.** Address canonical serialization spec in the Phase 1 design doc (before any signing code is written). Define consumer authentication in Phase 2 (before non-instar agents attempt to access gated fields).

The architecture is sound. The security model handles the hard cases. The phasing is logical. Ship it.

---

*Architecture reviewer — Round 2 — 2026-04-04*

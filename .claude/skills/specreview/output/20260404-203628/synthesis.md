# SpecReview Synthesis: Rich Agent Profiles for MoltBridge

**Review ID**: 20260404-203628
**Date**: 2026-04-04
**Round**: 1
**Reviewers**: Security, Scalability, Business, Architecture, Privacy, Adversarial, DX/API, Marketing
**Spec**: `/tmp/rich-agent-profiles-spec.md`

---

## Overall Assessment

**Status**: BLOCKED
**Average Score**: 4.8 / 10
**Score Range**: 3 - 6.5

| Reviewer | Status | Score | Key Finding |
|----------|--------|-------|-------------|
| Security | BLOCK | 3/10 | No profile authenticity model; LLM synthesis is injection surface; private data leakage |
| Scalability | CONDITIONAL | 4/10 | No cost model for LLM compilation; discovery payloads undefined; no storage model |
| Business | CONDITIONAL | 6.5/10 | Chicken-and-egg problem; must position vs A2A not compete with it; no revenue model |
| Architecture | CONDITIONAL | 6.5/10 | Principal vs agent identity confusion; no schema extension plan; discovery unresolved |
| Privacy | CONDITIONAL | 4/10 | No consent mechanism; no data minimization; no retention/deletion policy |
| Adversarial | BLOCK | 3/10 | LLM-generated false profiles trivial; Sybil laundering; memory poisoning |
| DX / API | CONDITIONAL | 6.5/10 | No profile schema defined; non-instar onboarding is a wall; freshness triggers undefined |
| Marketing | CONDITIONAL | 6.5/10 | "LinkedIn" analogy is a ceiling; no cold-start strategy; IQS is unmarketed |

---

## Consensus Findings

*Issues that 3+ reviewers independently identified:*

### 1. No Profile Schema Exists (7/8 reviewers)
Identified by: Architecture, DX, Security, Scalability, Business, Adversarial, Privacy

Every reviewer noted the spec describes *what* a profile should contain but never defines the actual data model. The current `ProfileUpdateRequest` only supports `capabilities[]`, `clusters[]`, and `a2a_endpoint`. No one can implement rich profiles without a concrete JSON schema.

**Recommended action**: Define the schema before anything else. This is the load-bearing decision.

### 2. Discovery Payloads Must Not Include Full Profiles (6/8 reviewers)
Identified by: Scalability, Architecture, DX, Security, Adversarial, Privacy

Full rich profiles in discovery responses would 10-50x payload size and destroy latency. Universal consensus: adopt a two-tier pattern — slim Discovery Card (≤1KB) for search results, full profile fetched on-demand via separate endpoint.

**Recommended action**: Design progressive disclosure (Tier 1: discovery summary, Tier 2: full profile, Tier 3: deep context with attestations).

### 3. LLM Synthesis Pipeline Is an Attack Surface (5/8 reviewers)
Identified by: Security, Adversarial, Architecture, Privacy, Scalability

Auto-compiling profiles from AGENT.md, MEMORY.md, git history means any attacker-controllable input becomes part of the published profile. MEMORY.md can be poisoned via Threadline messages; git history is partially third-party controlled. An LLM reading "I tried X but it failed" may generate "experienced in X."

**Recommended action**: Hybrid extraction — rule-based for structured signals, LLM only for the narrative bio field. Treat all source files as untrusted input. Hash-pin sources at compilation time.

### 4. Private Data Leakage from Source Files (5/8 reviewers)
Identified by: Security, Privacy, Adversarial, Architecture, DX

AGENT.md, MEMORY.md, and especially USER.md contain human PII, operational infrastructure details, auth token references, and collaborator relationships. Publishing these without filtering exposes data the humans behind agents never consented to share.

**Recommended action**: Explicit allowlist of profile-eligible fields. USER.md must NEVER be a profile source. MEMORY.md only contributes via explicitly tagged entries (e.g., `#profile-safe`).

### 5. IQS Must Not Be Tied to Profile Completeness (5/8 reviewers)
Identified by: Security, Adversarial, Architecture, Privacy, DX

If IQS rewards profile richness, attackers fill every field with plausible false content. Completeness signals effort, not legitimacy. This creates a structural incentive to over-share (privacy risk) and fabricate (trust risk).

**Recommended action**: Decouple IQS from profile richness entirely. IQS derives from verifiable behavioral signals only. Expose a separate `profile_completeness_score` for discovery ranking.

### 6. No Sybil Resistance for Open Registration (4/8 reviewers)
Identified by: Security, Adversarial, Business, Privacy

Nothing prevents one operator from spinning up dozens of agents that mutually attest to each other. Non-instar agents can register freely with no verification friction.

**Recommended action**: Registration cost mechanism; new registrations start at zero trust; attestation weight discounted by network proximity; circular ring detection.

### 7. No Consent or Deletion Mechanism (4/8 reviewers)
Identified by: Privacy, Security, DX, Adversarial

Auto-compilation publishes data without human review. Once published, data propagates through caches and relays. No GDPR-compliant deletion path exists.

**Recommended action**: Human-in-the-loop approval before first publication. `DELETE /profile` endpoint. Signed deletion notices propagating to caches.

### 8. A2A Alignment Is the Right Strategic Move (4/8 reviewers)
Identified by: Business, Architecture, DX, Marketing

Google A2A with 150+ partners is the winning open standard. MoltBridge should position as a complementary profile/narrative layer, not a competitor. "A2A agent cards tell you what an agent *can* do. MoltBridge profiles tell you what an agent *has done*."

**Recommended action**: Support `/.well-known/agent-card.json`. Extend A2A Agent Cards with MoltBridge-specific rich fields.

---

## Critical Issues (Blockers)

| # | Issue | Reviewer(s) | Severity | Suggested Fix |
|---|-------|-------------|----------|---------------|
| 1 | No profile authenticity verification — any agent can claim any accomplishment | Security, Adversarial | CRITICAL | Ed25519-signed profile payloads with canonical serialization + timestamp |
| 2 | LLM synthesis reads attacker-controllable inputs into published profiles | Security, Adversarial, Architecture | CRITICAL | Hybrid extraction: rule-based for claims, LLM only for narrative bio |
| 3 | No defense against LLM-generated false profiles and Sybil networks | Adversarial, Security | CRITICAL | Separate first-party claims from third-party attestations; only attestations affect trust |
| 4 | USER.md/MEMORY.md contain human PII with no filtering | Security, Privacy | CRITICAL | Explicit allowlist; USER.md never a source; tag-based MEMORY.md extraction |
| 5 | No consent mechanism for auto-compilation and publication | Privacy | CRITICAL | Mandatory human review gate before first publication |
| 6 | Principal vs Agent identity confusion in existing schema | Architecture | CRITICAL | New `AgentProfile` type distinct from `PrincipalProfile` |
| 7 | No profile schema exists — cannot implement | DX, Architecture | CRITICAL | Define concrete JSON schema before any other work |

---

## Conflicts

### Conflict 1: LLM Compilation Scope

- **Architecture** says: LLM only for narrative bio; rule-based for everything else
- **DX** says: LLM synthesis is the right call for nuanced profiles; just use Haiku-class models
- **Security** says: LLM synthesis should be treated as an untrusted pipeline with extraction templates
- **Resolution**: Converged — hybrid approach. Rule-based extraction for structured claims (capabilities, track record dates, project names), LLM synthesis ONLY for the narrative bio field from pre-extracted signals. Not raw MEMORY.md.

### Conflict 2: Non-Instar Agent Onboarding Timing

- **Business** says: Open the standard early to build network effects
- **Security/Adversarial** say: Implement Sybil resistance before opening non-instar registration
- **Resolution**: Needs cross-examination. Likely answer: instar-first flywheel (Phase 0), then open with registration friction (proof-of-work + zero initial trust).

### Conflict 3: How Much Privacy Infrastructure Is MVP-Blocking

- **Privacy** says: Consent mechanism, deletion propagation, and access tiers are all blockers
- **DX/Marketing** say: Ship with opt-in profiles and iterate on privacy infrastructure
- **Resolution**: Needs cross-examination. Minimum viable: human approval gate + explicit public/private field separation. Full deletion propagation can be Phase 2.

### Conflict 4: Revenue Model Urgency

- **Business** says: Must define monetization thesis now
- **Marketing** says: Free tier is the viral engine; worry about revenue at Phase 3
- **Resolution**: Not blocking for technical spec. But a monetization hypothesis should exist in the product strategy doc.

---

## Recommendations (Prioritized)

| Priority | Recommendation | Source Reviewers | Effort | Impact |
|----------|---------------|-----------------|--------|--------|
| P0 | Define the rich profile JSON schema | DX, Architecture, All | Medium | Critical |
| P0 | Implement profile signing (Ed25519 over canonical payload) | Security, Adversarial | Medium | Critical |
| P0 | Separate first-party claims from third-party attestations in data model | Adversarial, Security | Medium | Critical |
| P0 | Create explicit allowlist for profile-eligible source fields; ban USER.md | Security, Privacy | Low | Critical |
| P0 | Add human review gate before first profile publication | Privacy | Low | Critical |
| P1 | Two-tier discovery: slim card + full profile on-demand | Scalability, Architecture, DX | Medium | High |
| P1 | Hybrid compilation: rule-based extraction + LLM narrative only | Architecture, Security | Medium | High |
| P1 | Content-hash recompilation (only recompile on actual change) | Architecture, Scalability | Low | High |
| P1 | Sybil resistance: attestation ring detection + registration friction | Security, Adversarial | High | High |
| P1 | A2A Agent Card compatibility (`/.well-known/agent-card.json`) | Business, Architecture, DX | Medium | High |
| P1 | Decouple IQS from profile completeness | Security, Adversarial, Architecture | Low | High |
| P2 | Profile deletion endpoint + cache TTLs | Privacy, DX | Medium | Medium |
| P2 | Tiered LLM pipeline (Haiku extraction → Sonnet narrative) | Scalability | Medium | Medium |
| P2 | Non-instar onboarding template (YAML/JSON) | DX, Business | Low | Medium |
| P2 | Profile versioning with hash-chaining | Security, DX | Medium | Medium |
| P3 | IQS front-facing name and marketing story | Marketing | Low | Low |
| P3 | Enterprise governance tier | Marketing, Business | High | Low (for now) |

---

## Scalability Summary

| Phase | Assessment | Key Risks | Reviewers Agree? |
|-------|-----------|-----------|-----------------|
| **MVP** (10-50 agents) | Viable with fixes | No schema = can't start; LLM cost ~$15-30/mo | Yes |
| **Growth** (50-500 agents) | Requires architecture decisions | Discovery payload size; compilation costs $500-2K/mo without pipeline | Yes |
| **Scale** (500-5000 agents) | Needs explicit horizontal design | Sybil attacks viable; graph harvesting; synchronized recompilation spikes | Yes |
| **Viral spike** (5000+ in days) | Not designed for | Queue-backed compilation workers needed; rate limiting essential | Yes |

---

## Gaps

*Areas that no reviewer adequately covered:*

1. **Key rotation design**: No reviewer proposed a concrete key rotation mechanism. One compromised key poisons all profile history with no recovery path.
2. **Multi-hop profile integrity**: How does profile authenticity survive relay chains in Threadline? Signature verification at each hop?
3. **Profile version rollback semantics**: Can an agent roll back to a previous profile version? What are the security implications?
4. **Semantic search over profiles**: Vector embeddings for capability matching are mentioned but no one designed the search architecture.
5. **EU AI Act compliance**: Privacy reviewer noted it but no one assessed specific obligations for autonomous agent profiling systems.
6. **Agent sunset/off-boarding**: What happens to profile data when an agent is permanently retired? Different from deletion — may need tombstone records.
7. **Enterprise audit requirements**: Governance teams need audit trails of profile changes. No reviewer designed this.

---

## Name Analysis (from Marketing Reviewer)

**Current name**: MoltBridge
**Assessment**: Keep the platform name — it's distinctive and memorable. The Rich Profiles feature needs its own name.

**Alternatives suggested**:
1. **Provenance** — Signals verified history, track record, origin
2. **Manifest** — Ship's manifest, complete listing. Strong verb: "manifest your agent"
3. **AgentRoster** — Immediately clear, professional, intuitive
4. **Cartridge** — Loadable, portable, self-contained identity module
5. **Ledger** — Persistent, trustworthy, append-only record

**Key messaging**: "A2A agent cards are like business cards. MoltBridge profiles are like portfolios."

---

## Convergence Status

| Metric | Value |
|--------|-------|
| Reviewers in agreement (APPROVE) | 0 / 8 |
| Conditional approvals | 6 / 8 |
| Blockers | 2 / 8 |
| Open conflicts | 2 |
| Resolved conflicts | 2 |

**Convergence**: CONVERGING

All reviewers agree the problem is real and the direction is correct. The blockers are addressable — they're missing design decisions, not fundamental flaws. The spec needs a security addendum, a concrete schema, and privacy guardrails before implementation.

---

## Next Steps

- [ ] Address 7 critical issues before proceeding (P0 recommendations)
- [ ] Resolve 2 open conflicts via cross-examination (non-instar timing, privacy MVP scope)
- [ ] Define the rich profile JSON schema (unlocks everything else)
- [ ] Write security requirements addendum (profile signing, Sybil resistance, source allowlist)
- [ ] Add privacy guardrails (human review gate, field visibility tiers, deletion endpoint)
- [ ] Re-run review for affected areas: `/specreview [updated-spec] --round 2 --reviewers security,adversarial,privacy`

---

*Generated by SpecReview multi-agent analysis. 8 reviewers, 1 round, 0 approvals.*

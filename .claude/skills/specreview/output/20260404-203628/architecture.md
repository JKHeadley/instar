# Architecture Review: Rich Agent Profiles for MoltBridge

**Approval Status: CONDITIONAL APPROVE** | **Score: 6.5/10**

## Research Findings

**Schema.org / DID Standards**: MoltBridge's existing Ed25519 pubkeys map directly to `did:key` or `did:web` DID Documents. The most relevant precedent is Google's **A2A Agent Card** format — a JSON file at `/.well-known/agent.json` that includes name, description, capabilities, skills, and endpoint. MoltBridge already references `a2a_endpoint` in `AgentNode`, making A2A alignment natural.

**LLM Compilation Architecture**: Best practice is **hybrid extraction** — rule-based for structured signals (git commit counts, job names, capability list) + LLM only for the narrative `bio` field. Pure LLM compilation over raw MEMORY.md is a hallucination risk. Track records need evidence pointers (git hash, job run ID), not LLM assertion.

**Event-Driven Updates**: Use content-hash-based recompilation — hash source inputs, only recompile on change. This prevents expensive LLM calls on no-op updates and makes the pipeline idempotent.

**Existing Frameworks**: AutoGen, CrewAI, LangGraph have no persistent identity layers. A2A Agent Cards (served at a well-known URL) are the closest industry precedent for discoverable agent profiles.

## Critical Issues

**1. The `principal` vs `agent` identity confusion is unresolved**

`PrincipalProfile` in `principal.ts` models a *human* — it has `industry`, `role`, `organization`. The spec wants rich *agent* profiles. These are different objects. Without resolving this, developers will bolt narrative fields onto the wrong schema. `AgentNode` currently only has `capabilities: string[]`, `trust_score`, `pubkey`, `platform` — nowhere to store narrative, track record, or specializations.

**Fix**: Introduce `AgentProfile` as a distinct type. Relationship: `AgentNode -[:HAS_PROFILE]-> AgentProfile`.

**2. LLM compilation with no quality gate invites profile pollution**

An LLM reading MEMORY.md containing "I tried X but it failed" may generate "experienced in X." False capability signals degrade discovery quality and become a trust attack vector.

**Fix**: Require confidence scores per compiled field. Track record entries must link to evidence (git hash, job run ID) before being marked `verified`. LLM synthesis should be scoped to the narrative `bio` field only — not to capability claims.

**3. No schema extension plan**

Current `ProfileUpdateRequest` only supports `capabilities[]`, `clusters[]`, `a2a_endpoint`. Rich profiles need `narrative`, `specializations`, `track_record[]`, `role_context`. The SDK is published at `moltbridge@0.1.6`. A breaking schema change without a versioning plan will break downstream clients.

**4. Discovery integration is architecturally unresolved**

"Full profile or summary + link?" is not cosmetic. Full profiles inline would 10-50x discovery payload size and destroy latency. The answer should be: discovery returns a slim card (current fields + `profile_summary` + `profile_url`); full profiles fetched separately, on demand, with auth. This is the A2A pattern.

## Recommendations

- **R1**: Three-tier profile architecture: `AgentNode` (identity/trust) → `AgentProfile` (narrative/track record) → `AgentProfileVersion[]` (history). Separates immutable identity from mutable narrative from audit trail.
- **R2**: Hybrid compilation pipeline: rule-based extraction for structured signals → LLM synthesis for `narrative` field only from those signals (not raw MEMORY.md).
- **R3**: Content-hash recompilation: hash all source inputs before triggering LLM calls. Idempotent, cheap.
- **R4**: Serve profile summaries at `/.well-known/agent-profile.json` for non-instar agents. Aligns with A2A, enables any HTTP server to participate.
- **R5**: New API surface: `POST /agent/profile`, `PUT /agent/profile`, `GET /agent/profile/:id`, `GET /agent/profile/:id/summary`. Do not reuse `/principal/*` endpoints.
- **R6**: IQS should factor in profile richness only via improved `relevance_score` (richer profiles → better capability matching). Do not add profile completeness as a direct IQS component — creates padding incentives.

## Scalability Assessment

- **Neo4j**: Track record entries belong as graph relationships (`-[:CONTRIBUTED_TO]-> Project`) not embedded property arrays. Graph relationships are Neo4j's strength.
- **Discovery**: Rich profiles must NOT travel inline with discovery results. Summary + URL is load-bearing.
- **LLM at scale**: Content-hash deduplication (R3) is essential. 100K agents recompiling weekly = 100K LLM calls/week without it.
- **Event queue**: MEMORY.md updates from 10K active agents need rate limiting and priority routing for recompilation.

The problem diagnosis is accurate, the data sources are right, and the existing infrastructure (Ed25519 identity, attestation system, enrichment levels, circuit-broken client) is solid. The gap is the profile model itself — what is the exact schema, where does it live in Neo4j, how does LLM compilation stay honest, what is the SDK versioning strategy. These are foundational decisions that need answers before implementation, not implementation details.
